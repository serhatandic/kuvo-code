// A bot's goal (PROTOCOL.md, "Work › Goals"), of any length: a bot puts its plan to you on one card,
// with what it checked, what it may spend in a period, and how often you hear how it goes; only you
// start it, and nothing it would publish is held back (its conversation's mode decides). As it goes, what its sessions ask waits for you (never a
// no, never a stall), a model's limit or a daily limit pauses what hit it until the reset and the box
// carries it on then (through a restart too), a spend cap starts again with its period, an end you set
// has it wrap up and report, and digests and the report reach your phones. Its sessions run as any
// conversation in their mode does: only what you set holds them back. Each call by a
// process of its own, as a machine's tools ask it (`kuvo-link.js box route`); the box's watch over
// goals in this one. The real box script on a folder of the test's own; only the engine is a
// stand-in.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/bots-goals.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { atEnd, removeAtEnd } from "./at-end.js";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-bots-goals-")));
removeAtEnd(home);
process.env.KUVO_HOME = home;
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");
const script = fileURLToPath(new URL("../../Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url));
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const driftwood = path.join(home, "work", "driftwood");
const developer = path.join(home, "Developer");

// Pixel, a bot here on Approve All.
const pixelFolder = path.join(home, "bots", "bot_pixel00001");
const by = { bot: "bot_pixel00001", name: "Pixel" };

// The engine: Pixel's conversation and a session of its work; what each was sent, what each asks,
// and how each ask was answered.
let sessions, prompts, made, asked, replied, interrupted, active, forms, dismissed, answeredForms, failures, written, stepsSince;
const tokens = () => ({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });
function resetEngine() {
  sessions = new Map([
    ["ses_pixel", { id: "ses_pixel", title: "Pixel", location: { directory: path.join(pixelFolder, "workspace") }, permissions: [], time: { created: 1, updated: 5 }, cost: 0, tokens: tokens() }],
    ["ses_site", { id: "ses_site", title: "Build the site", location: { directory: driftwood }, permissions: [], time: { created: Date.now(), updated: Date.now() }, cost: 0, tokens: tokens(), metadata: { kuvo: { startedBy: "ses_pixel", by, depth: 1, wake: ["finished", "asks"] } } }],
  ]);
  prompts = [];
  made = [];
  asked = new Map();
  replied = [];
  interrupted = [];
  active = new Set();
  forms = new Map();
  dismissed = [];
  answeredForms = [];
  failures = new Map();
  written = new Map();
  stepsSince = new Map();
}
resetEngine();
const withSource = ask => ({ ...ask, source: { type: "tool", messageID: `msg_${ask.id}`, id: `call_${ask.id}` } });
const engine = http.createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    const reply = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    const url = new URL(request.url, "http://x");
    if (url.pathname === "/api/session" && request.method === "GET") {
      const parent = url.searchParams.get("parentID");
      const listed = [...sessions.values()].filter(each => (parent && parent !== "null" ? each.parentID === parent : !each.parentID));
      return reply(url.searchParams.get("limit") === "200" ? { data: listed, cursor: null } : { data: listed });
    }
    if (url.pathname === "/api/session" && request.method === "POST") {
      const given = JSON.parse(body);
      const id = `ses_new${made.length + 1}`;
      made.push({ id, ...given });
      sessions.set(id, { id, title: given.title, permissions: given.permissions, location: given.location, time: { created: Date.now(), updated: Date.now() }, cost: 0, tokens: tokens() });
      return reply({ data: { id } });
    }
    if (url.pathname === "/api/session/active") return reply({ data: Object.fromEntries([...active].map(id => [id, {}])) });
    const one = url.pathname.match(/^\/api\/session\/([^/]+)(\/.*)?$/);
    const id = one && decodeURIComponent(one[1]);
    if (one && !one[2] && request.method === "GET") return sessions.has(id) ? reply({ data: sessions.get(id) }) : reply({ message: "No such session." }, 404);
    if (one && !one[2] && request.method === "PATCH") {
      const change = JSON.parse(body);
      sessions.set(id, { ...sessions.get(id), ...(change.metadata ? { metadata: change.metadata } : {}), ...(change.permissions ? { permissions: change.permissions } : {}) });
      return reply({ data: sessions.get(id) });
    }
    if (one?.[2] === "/prompt") {
      prompts.push({ to: id, ...JSON.parse(body) });
      return reply({});
    }
    if (one?.[2] === "/message" && url.searchParams.get("order") === "desc" && failures.has(id)) {
      // Its last turn, failed: as the engine ends one.
      return reply({ data: [{ id: `idle_${id}`, type: "idle", outcome: "failed", error: { message: failures.get(id) } }] });
    }
    if (one?.[2] === "/message" && written.has(id)) {
      // What was written to it, newest first, after its turn's steps since, a page at a time.
      const steps = Array.from({ length: stepsSince.get(id) ?? 0 }, (_, at) => ({ id: `step_${id}_${at}`, type: "assistant", content: [{ type: "text", text: "Looking." }] }));
      const all = [...steps, ...written.get(id).map((text, at) => ({ id: `msg_${id}_${at}`, type: "user", text }))];
      const from = Number(url.searchParams.get("cursor") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 100);
      return reply({ data: all.slice(from, from + limit), cursor: { next: from + limit < all.length ? String(from + limit) : null } });
    }
    if (one?.[2] === "/message") {
      const calls = (asked.get(id) ?? []).map(withSource).map(ask => ({ id: ask.source.messageID, type: "assistant",
        content: [{ type: "tool", id: ask.source.id, name: ask.tool ?? (ask.action === "shell" ? "shell" : ask.action), state: { status: "running", input: ask.input ?? (ask.action === "shell" ? { command: ask.resources[0] } : { filePath: ask.resources[0] }) } }] }));
      return reply({ data: calls });
    }
    if (one?.[2] === "/inbox") return reply({ data: [] });
    if (one?.[2] === "/interrupt") {
      interrupted.push(id);
      active.delete(id);
      return reply({});
    }
    if (one?.[2] === "/permission") return reply({ data: (asked.get(id) ?? []).map(withSource) });
    if (one?.[2] === "/form") return reply({ data: forms.get(id) ?? [] });
    const form = one?.[2]?.match(/^\/form\/([^/]+)$/);
    if (form && request.method === "DELETE") {
      dismissed.push({ session: id, form: decodeURIComponent(form[1]), message: url.searchParams.get("message") });
      forms.set(id, (forms.get(id) ?? []).filter(each => each.id !== decodeURIComponent(form[1])));
      return reply({});
    }
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
    if (request.url.includes("/instructions/entries")) return reply({ data: [] });
    reply({ message: "Not here." }, 404);
  });
});
await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
atEnd(() => { engine.closeAllConnections(); engine.close(); });
const target = () => [{ port: engine.address().port, password: "p" }];

// The agents bridge, beside the engine: the conversation's goal (its loop), as it's set, taken away
// and read, and every goal it keeps.
let loops;
// Reads of a conversation's goal the bridge fails (busy, or restarting), before it answers again.
let readsFailing = 0;
const bridge = http.createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    const reply = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    const pathname = new URL(request.url, "http://x").pathname;
    if (pathname === "/api/kuvo/goals" && request.method === "GET") return reply({ data: [...loops.values()] });
    const found = pathname.match(/^\/api\/kuvo\/goals\/([^/]+)$/);
    if (!found) return reply({ message: "Not here." }, 404);
    const session = decodeURIComponent(found[1]);
    if (request.method === "PUT") {
      loops.set(session, { session, ...JSON.parse(body), state: "working" });
      return reply({ data: loops.get(session) });
    }
    if (request.method === "DELETE") return loops.delete(session) ? reply({}) : reply({ message: "That conversation has no goal." }, 404);
    if (readsFailing > 0) {
      readsFailing -= 1;
      return reply({ message: "Busy." }, 500);
    }
    return loops.has(session) ? reply({ data: loops.get(session) }) : reply({ message: "That conversation has no goal." }, 404);
  });
});
await new Promise(resolve => bridge.listen(0, "127.0.0.1", resolve));
// A process the box takes for the bridge's (by its name).
const bridgeProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)", "kuvo-agents"], { stdio: "ignore" });
atEnd(() => { bridge.closeAllConnections(); bridge.close(); bridgeProcess.kill(); });

beforeEach(() => {
  resetEngine();
  loops = new Map();
  readsFailing = 0;
  for (const each of ["box", "run", "Developer", "bots", "bin", "work"]) fs.rmSync(path.join(home, each), { recursive: true, force: true });
  fs.mkdirSync(driftwood, { recursive: true });
  spawnSync("git", ["init", "-q", driftwood], { env: { ...process.env, HOME: home } });
  fs.mkdirSync(developer, { recursive: true });
  write(path.join(home, "box", "projects.json"), JSON.stringify({ projects: [{ directory: driftwood, name: "Driftwood", folders: [] }] }));
  write(path.join(pixelFolder, "bot.json"), JSON.stringify({ kuvo: 1, id: "bot_pixel00001", name: "Pixel", job: "Builds apps.", look: { color: "graphite", shape: "squircle", face: "bright" }, created: "2026-10-01T09:00:00Z", updated: "2026-10-01T09:00:00Z" }));
  write(path.join(pixelFolder, "session"), "ses_pixel");
  fs.mkdirSync(path.join(pixelFolder, "workspace"), { recursive: true });
  write(path.join(home, "run", "engine.json"), JSON.stringify({ port: engine.address().port, password: "p", version: "0.0.0" }));
  write(path.join(home, "run", "bridge.json"), JSON.stringify({ port: bridge.address().port, password: "p", pid: bridgeProcess.pid }));
  fs.mkdirSync(path.join(home, "bin"), { recursive: true });
  fs.copyFileSync(new URL("../../Sources/KuvoLink/Resources/bot-words.json", import.meta.url), path.join(home, "bin", "bot-words.json"));
});

// The box's answer to one request, as a machine's tool asks it: a process of its own, on a box that
// may work on its own (`unattended`, its commands in the sandbox), or one that can't yet; with more
// in its environment (`env`). Bytes that aren't text come as `bytes`, with their `type`.
function route(method, pathname, body, { unattended = true, env: more = {} } = {}) {
  return new Promise((resolve, reject) => {
    // (In the test's own time zone, which a runner may set apart from the machine's: midnight is the same one.)
    const env = { ...process.env, KUVO_HOME: home, HOME: home, TMPDIR: home, TZ: Intl.DateTimeFormat().resolvedOptions().timeZone, ...more };
    delete env.KUVO_TEST_SANDBOX_ON;
    if (unattended) env.KUVO_TEST_SANDBOX_ON = "1";
    const child = spawn(process.execPath, [script, "box", "route"], { env, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.on("error", reject);
    child.on("close", () => {
      const said = JSON.parse(out.trim().split("\n").pop());
      resolve(said.bodyBase64 === undefined ? { status: said.status, body: JSON.parse(said.body) } : { status: said.status, bytes: Buffer.from(said.bodyBase64, "base64"), type: said.type });
    });
    child.stdin.end(JSON.stringify({ method, path: pathname, body }));
  });
}
const tool = async (name, args, { session = "ses_pixel", ...rest } = {}) => (await route("POST", "kuvo/agent-tools", { name, arguments: args, session }, rest)).body;

// The landing-page goal, as Pixel puts it.
const PLAN = {
  goal: "Launch a landing page for my coffee subscription, Driftwood. Get a domain, and add Stripe checkout.",
  title: "Driftwood's landing page",
  steps: [{ text: "Build the site", detail: "Hero, menu and the\norder page" }, { text: "Buy the domain", site: "cloudflare.com" }, { text: "Set up DNS", after: [2] }, { text: "Deploy", phase: "Launch", after: [1, 3] }, { text: "Add checkout", phase: "Launch" }],
  checks: [
    { text: "Add a Cloudflare API token", detail: "for the domain, DNS and hosting", url: "https://dash.cloudflare.com/profile/api-tokens", button: "Add" },
    { text: "Stripe key works", ok: true },
  ],
  spend: [{ what: "driftwood.coffee", cap: 15 }, { what: "ads", cap: 20, per: "day" }],
  // What a bot told by older words still sends: nothing comes of it.
  public: ["Publish the site when it's ready", "Turn on live payments"],
  projects: ["Storefront"],
};
const goals = async () => (await route("GET", "kuvo/work/goals")).body.goals;
async function startedGoal(answer = {}) {
  const proposed = await tool("propose_goal", PLAN);
  assert.equal(proposed.isError, false, proposed.text);
  const [goal] = await goals();
  const started = await route("POST", `kuvo/work/goals/${goal.id}`, { action: "start", ...answer });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  return started.body.goal;
}
const kept = () => JSON.parse(fs.readFileSync(path.join(home, "run", "work", "goals.json"), "utf8")).goals[0];
const keep = change => {
  const file = path.join(home, "run", "work", "goals.json");
  const all = JSON.parse(fs.readFileSync(file, "utf8"));
  change(all.goals[0]);
  fs.writeFileSync(file, JSON.stringify(all));
};
// Your phones' notifications, as the box's watch tells them.
let told;
const tell = notice => { told.push(notice); return true; };
const look = (now = Date.now()) => link.lookAtGoals(tell, target, { now });
beforeEach(() => { told = []; });

test("a bot puts its goal to you on one card: the plan with its phases, what it checked, what it may spend and in what period, how often you hear how it goes", async () => {
  const said = await tool("propose_goal", PLAN, { unattended: false });
  assert.equal(said.isError, false, said.text);
  assert.match(said.text, /can't work on it alone yet/);
  const [goal] = (await route("GET", "kuvo/work/goals", null, { unattended: false })).body.goals;
  assert.equal(goal.state, "proposed");
  assert.equal(goal.name, "Pixel");
  assert.equal(goal.session, "ses_pixel");
  assert.equal(goal.title, "Driftwood's landing page");
  assert.deepEqual(goal.steps.map(each => [each.id, each.text, each.state, each.phase ?? null, each.after ?? []]), [["s1", "Build the site", "todo", null, []], ["s2", "Buy the domain", "todo", null, []], ["s3", "Set up DNS", "todo", null, ["s2"]], ["s4", "Deploy", "todo", "Launch", ["s1", "s3"]], ["s5", "Add checkout", "todo", "Launch", []]], "what each waits for, so the rest run side by side");
  assert.equal(goal.alone, false);
  const alone = goal.checks.find(each => each.id === "alone");
  assert.deepEqual([alone.text, alone.state, alone.by], ["This machine can't work on its own yet", "failed", "box"]);
  assert.doesNotMatch(JSON.stringify(goal), /fence|sandbox|night|morning|tonight/i, "the card never says fence or sandbox, nor anything about nights");
  assert.deepEqual(goal.steps.map(each => each.site ?? null), [null, "cloudflare.com", null, null, null], "a step done at a service names its site");
  assert.deepEqual(goal.steps.map(each => each.detail ?? null), ["Hero, menu and the order page", null, null, null, null], "a step's short description, kept on one line; none where it has none");
  const token = goal.checks.find(each => each.text === "Add a Cloudflare API token");
  assert.equal(token.site, "dash.cloudflare.com", "a check's site, from its page");
  assert.deepEqual([token.state, token.by, token.action], ["needs", "bot", { kind: "open", label: "Add", url: "https://dash.cloudflare.com/profile/api-tokens" }]);
  assert.deepEqual(goal.spend.map(each => [each.what, each.cap, each.currency, each.per, each.spent]), [["driftwood.coffee", 15, "USD", "goal", 0], ["ads", 20, "USD", "day", 0]]);
  assert.deepEqual(goal.public, [], "nothing it would publish is held back for a switch");
  assert.equal(goal.digest, "day", "a plan in phases gets a daily digest unless the bot says");
  assert.equal(goal.wake, false);

  // It can start all the same: it runs with you there, what its sessions ask waiting for you.
  const start = await route("POST", `kuvo/work/goals/${goal.id}`, { action: "start" }, { unattended: false });
  assert.equal(start.status, 200);
  assert.equal(start.body.goal.state, "running");
});

test("only you start the goal, with its end and its caps; the bot's told what's approved, and nothing it would publish waits on a switch", async () => {
  await tool("propose_goal", { ...PLAN, steps: ["Build the site"] });
  await tool("propose_goal", PLAN);
  const listed = await goals();
  assert.equal(listed.length, 1, "proposed again, it's the one card");
  assert.equal(listed[0].alone, true);
  const ends = Date.now() + 7 * 86_400_000;
  const started = await route("POST", `kuvo/work/goals/${listed[0].id}`, { action: "start", wake: true, digest: "week", ends, spend: [{ cap: 12 }, { per: "week" }] });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const goal = started.body.goal;
  assert.deepEqual([goal.state, goal.wake, goal.digest, goal.ends], ["running", true, "week", ends]);
  assert.deepEqual(goal.public, []);
  assert.deepEqual(goal.spend.map(each => [each.cap, each.per]), [[12, "goal"], [20, "week"]]);
  const [message] = prompts;
  assert.equal(message.to, "ses_pixel");
  assert.match(message.text, /^\[Goal started\]/);
  // The box's own words to the bot, marked for what they are: a client shows a line, never your bubble.
  assert.deepEqual(message.metadata, { kuvo: { note: { from: "Goal", line: "Goal started" } } });
  assert.doesNotMatch(message.text, /draft|switched/i, "never told to keep what it publishes as a draft");
  assert.match(message.text, /ads, up to 20 USD a week/);
  assert.doesNotMatch(message.text, /night|morning|sleep/i);

  const asked = await route("POST", "kuvo/agent-tools", { name: "may_publish", arguments: { step: "p1" }, session: "ses_pixel" });
  assert.equal(asked.status, 400, "no tool to ask: its mode decides");
  assert.equal((await route("POST", `kuvo/work/goals/${listed[0].id}`, { action: "start" })).status, 400);
  assert.equal((await tool("propose_goal", PLAN)).isError, true);
  assert.match((await tool("propose_goal", PLAN, { session: "ses_site" })).text, /Only a bot takes a goal/);
});

test("an end the bot proposed is taken away when you start with no end (ends: null), and kept when you say nothing of it", async () => {
  const proposedEnd = Date.now() + 3 * 86_400_000;
  await tool("propose_goal", { ...PLAN, ends: proposedEnd });
  const [card] = await goals();
  assert.equal(card.ends, proposedEnd);
  const started = await route("POST", `kuvo/work/goals/${card.id}`, { action: "start", ends: null });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.goal.ends, undefined, "None on the card: no end");
  assert.doesNotMatch(prompts.at(-1).text, /It ends at/);
  assert.equal((await route("POST", `kuvo/work/goals/${card.id}`, { action: "stop" })).status, 200);

  await tool("propose_goal", { ...PLAN, ends: proposedEnd });
  const [again] = (await goals()).filter(each => each.state === "proposed");
  const kept = await route("POST", `kuvo/work/goals/${again.id}`, { action: "start" });
  assert.equal(kept.body.goal.ends, proposedEnd, "nothing said of it: the bot's end stands");
});

test("/goal in a bot's chat asks it for a plan at once, and Not Now tells it", async () => {
  const asked = await route("POST", "kuvo/work/goals/ask", { session: "ses_pixel", goal: "Ship the Driftwood site this week" });
  assert.equal(asked.status, 200);
  // Your words as you wrote them, then what the bot's told in the block your bubble leaves out
  // (KuvoClient's SentWithKeyword), so it reads as the composer showed it: /goal and your words.
  const [words, block] = prompts[0].text.split("\n\n<sent-with>\n");
  assert.equal(words, "Ship the Driftwood site this week");
  const lines = block.split("\n");
  // (Clients read the heading and /goal, and leave out the block whole: how to plan it is the bot's.)
  assert.deepEqual(lines.slice(0, 2), ["The user sent this as a goal, with Kuvo Code's /goal. Plan it, check what it needs, and put it to them with propose_goal before doing any of the work:", "/goal"]);
  assert.equal(lines.at(-1), "</sent-with>");
  assert.equal((await route("POST", "kuvo/work/goals/ask", { session: "ses_site", goal: "x" })).status, 400, "only a bot's chat");

  await tool("propose_goal", PLAN);
  const [goal] = await goals();
  const declined = await route("POST", `kuvo/work/goals/${goal.id}`, { action: "decline" });
  assert.equal(declined.body.goal.state, "declined");
  assert.match(prompts.at(-1).text, /^\[Not now\]/);
  assert.deepEqual(prompts.at(-1).metadata, { kuvo: { note: { from: "Goal", line: "You said not now" } } });
});

// The user's goal for a bot that builds iOS apps, with the folder they want it in.
const MONEY = "build an ios app that would print money. project should be at ~/Desktop/main/money-printer";

test("a bot on a goal leads it as a person with a team does: it plans steps for sessions, makes the project where you named it, hands each step to a session and writes no code itself", async () => {
  const desktop = path.join(home, "Desktop", "main");
  fs.mkdirSync(desktop, { recursive: true });
  atEnd(() => fs.rmSync(path.join(home, "Desktop"), { recursive: true, force: true }));
  // As it plans: steps that are sessions' tasks, the project by the folder you named, nothing made yet.
  assert.equal((await route("POST", "kuvo/work/goals/ask", { session: "ses_pixel", goal: MONEY })).status, 200);
  const planning = prompts[0].text.split("\n\n<sent-with>\n")[1];
  assert.match(planning, /one session's whole task/);
  assert.match(planning, /projects: .*folder .* as a full path/);
  assert.match(planning, /make_project once the goal starts/);
  assert.match(planning, /Make nothing before \[Goal started\]/);

  const proposed = await tool("propose_goal", { goal: MONEY, title: "Money printer", steps: ["Build the app's screens", "Add in-app purchases", { text: "Write the tests", after: [1, 2] }], projects: ["~/Desktop/main/money-printer"] });
  assert.equal(proposed.isError, false, proposed.text);
  const [card] = await goals();
  assert.equal(card.checks.find(each => each.id === "projectsFolder"), undefined, "no projects folder to pick: you named where it goes");
  const started = await route("POST", `kuvo/work/goals/${card.id}`, { action: "start" });
  assert.equal(started.status, 200, JSON.stringify(started.body));

  // As it starts: make the project there, a session for each step, follow them up, write no code.
  const go = prompts.at(-1).text;
  assert.match(go, /^\[Goal started\]/);
  assert.match(go, /Make money-printer with make_project \(name "money-printer", folder "~\/Desktop\/main\/money-printer"\) first: you may, without asking\. Never make a project's folder with mkdir or git init\./);
  assert.match(go, /Hand each step to a session with start_session: in the project, with the step's number \(step\)/);
  assert.match(go, /each in a worktree of its own/);
  assert.match(go, /Start every step that waits for nothing at once, each in a worktree of its own/);
  assert.doesNotMatch(go, /no commits yet/, "a new project has its first commit already, so no step waits for one");
  assert.match(go, /woken when one finishes or asks\. Read its report/);
  assert.match(go, /Write no code and make no files of the work yourself/);
  assert.match(go, /Unless the user told you to do it yourself/);

  // The project, where you named it, at once: it was in the plan you started.
  const project = await tool("make_project", { name: "money-printer" });
  assert.equal(project.isError, false, project.text);
  assert.ok(fs.existsSync(path.join(desktop, "money-printer", ".git")), project.text);
  assert.match(project.text, /~\/Desktop\/main\/money-printer/);
  assert.deepEqual((await route("GET", "kuvo/work/asks")).body.asks, [], "nothing asked");
  const first = await tool("start_session", { task: "Build the app's screens.", project: "money-printer", step: 1 });
  assert.equal(first.isError, false, first.text);
  assert.equal(made.at(-1).location.directory, path.join(desktop, "money-printer"), "its session works in the project");

  // One that isn't in the plan, where you name it, is asked as before, showing where it goes, and
  // made there without a projects folder picked, with the folders on the way there.
  const asking = tool("make_project", { name: "Coin flip", folder: "~/Desktop/side/coin-flip" });
  let ask;
  while (!(ask = (await route("GET", "kuvo/work/asks")).body.asks[0])) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([ask.project, ask.folder, ask.folderName, ask.suggested], ["Coin flip", path.join(desktop, "..", "side", "coin-flip"), "coin-flip", undefined]);
  assert.equal((await route("POST", `kuvo/work/asks/${ask.id}`, { answer: "allow" })).status, 200);
  assert.equal((await asking).isError, false);
  assert.ok(fs.existsSync(path.join(desktop, "..", "side", "coin-flip", ".git")));

  // A conversation that isn't a bot gets no goal of this kind, and nothing of it.
  const before = prompts.length;
  assert.equal((await route("POST", "kuvo/work/goals/ask", { session: "ses_site", goal: MONEY })).status, 400);
  assert.equal(prompts.length, before);
});

test("what its sessions ask waits for you: never said no to, listed once it settles, and gone once it's answered", async () => {
  await startedGoal();
  asked.set("ses_site", [{ id: "per_install", action: "shell", resources: ["npm install sharp"] }]);
  forms.set("ses_site", [{ id: "frm_1", title: "Which domain?", fields: [{ key: "domain", type: "string", description: "Which domain should I buy?" }] }]);
  const now = Date.now();
  await look(now);
  assert.deepEqual((await goals())[0].waiting, [], "the bot has a moment to answer it first");
  await look(now + 5 * 60_000);
  await look(now + 30 * 86_400_000);
  assert.deepEqual(replied, [], "a month on, it's still asked, never a no");
  assert.deepEqual(dismissed, []);
  const waiting = (await goals())[0].waiting;
  assert.deepEqual(waiting.map(each => [each.kind, each.session]), [["ask", "ses_site"], ["ask", "ses_site"]]);
  assert.match(waiting[1].text, /^Build the site asks: Which domain should I buy\?/);
  assert.equal(told.filter(each => each.category === "blocked").length, 0, "the session's own ask notifies as asks do; nothing twice");
  asked.set("ses_site", []);
  await look(now + 30 * 86_400_000);
  assert.deepEqual((await goals())[0].waiting.map(each => each.text), [waiting[1].text], "answered, it leaves the list");
});

test("answering what the bot asks clears its row at once, on every client, and what held up a step goes once the bot goes on with that step", async () => {
  await startedGoal();
  forms.set("ses_pixel", [{ id: "frm_concept", title: "Concept approval", fields: [{ key: "q0", type: "string", description: "Go with LeafCheck, or change it?" }] }]);
  await look();
  // The bot keeps the decision as waiting too, holding up the step it's for.
  assert.equal((await tool("goal_progress", { waiting: { kind: "judgment", text: "Approve the concept before building", step: 4 } })).isError, false);
  assert.deepEqual((await goals())[0].waiting.map(each => [each.kind, each.text.endsWith("Go with LeafCheck, or change it?") || each.text]), [["ask", true], ["judgment", "Approve the concept before building"]]);
  // You answer: as the engine says so, its row goes, without waiting for the box's next look,
  // and clients are told it changed.
  const changes = () => JSON.parse(fs.readFileSync(path.join(home, "run", "work", "changes.json"), "utf8"))[kept().bot];
  const before = changes();
  await link.workWatcher(target()[0], target, { schedule: () => {} })({ type: "form.replied", data: { id: "frm_concept", sessionID: "ses_pixel" } });
  assert.deepEqual((await goals())[0].waiting.map(each => each.text), ["Approve the concept before building"], "the answered question's row is gone at once");
  assert.ok(changes() > before, "clients are told it changed");
  // A look that read the conversation's asks before your answer doesn't bring it back.
  await look();
  assert.deepEqual((await goals())[0].waiting.map(each => each.text), ["Approve the concept before building"], "answered, it stays gone");
  forms.set("ses_pixel", []);
  // What holds up a step under way stays while the bot only says how far it's got.
  await tool("goal_progress", { steps: [{ step: 3, state: "doing" }] });
  await tool("goal_progress", { waiting: { kind: "you", text: "Add your RevenueCat key", step: 3 } });
  assert.doesNotMatch((await tool("goal_progress", { steps: [{ step: 3, state: "doing", progress: 0.5, note: "Half the screens" }] })).text, /no longer waiting/);
  assert.deepEqual((await goals())[0].waiting.map(each => each.text), ["Approve the concept before building", "Add your RevenueCat key"]);
  // The bot goes on with the step it held up: that's settled too, whether or not it says so.
  const said = await tool("goal_progress", { steps: [{ step: 4, state: "doing" }] });
  assert.match(said.text, /1 no longer waiting, as its step goes on/);
  assert.deepEqual((await goals())[0].waiting.map(each => each.text), ["Add your RevenueCat key"]);
  assert.equal((await tool("goal_progress", { waiting: { kind: "judgment", text: "Pick a color", step: null } })).isError, false, "null is no step, as elsewhere");
  assert.equal((await tool("goal_progress", { waiting: { kind: "judgment", text: "Pick a name", step: 9 } })).isError, true, "a step the plan doesn't have is refused");
});

test("a session that hits a model's limit is paused until the reset, kept through a restart, and carried on by the box then", async () => {
  await startedGoal();
  await tool("start_session", { task: "Build the site.", project: "Driftwood", step: 1 });
  const site = made[0].id;
  assert.deepEqual(kept().steps[0].sessions, [site], "its track follows the session");
  assert.equal(kept().steps[0].state, "doing");
  sessions.get(site).model = { providerID: "anthropic", id: "claude-opus-5-5" };
  sessions.get(site).metadata = { kuvo: { startedBy: "ses_pixel", by, depth: 1 } };
  failures.set(site, "You've hit your usage limit. Your limit resets in 2h.");
  const now = Date.now();
  await look(now);
  let goal = (await goals())[0];
  assert.equal(goal.paused.length, 1);
  assert.equal(goal.paused[0].why, "Claude's limit");
  assert.equal(goal.paused[0].session, site);
  assert.ok(Math.abs(goal.paused[0].until - (now + 2 * 3_600_000)) < 5_000);
  assert.deepEqual([goal.steps[0].state, goal.steps[0].resumes], ["paused", goal.paused[0].until]);
  assert.equal(goal.state, "running", "a limit never ends the goal");
  await look(now + 60_000);
  assert.equal((await goals())[0].paused.length, 1, "the same failure isn't taken twice");
  assert.equal(prompts.filter(each => each.to === site && /Limit reset/.test(each.text)).length, 0);

  // The box stops, and looks again past the reset (all it knows is in goals.json): carried on.
  failures.delete(site);
  await look(now + 2 * 3_600_000 + 60_000);
  assert.match(prompts.filter(each => each.to === site).at(-1).text, /^\[Limit reset\] Claude's limit has reset\. Carry on where you stopped\./);
  goal = (await goals())[0];
  assert.deepEqual(goal.paused, []);
  assert.equal(goal.steps[0].state, "doing");
  assert.ok(goal.waited > 0, "how long it waited, for the digest");
});

test("a daily limit you set pauses the goal until midnight, and the bot is woken to carry on then", async () => {
  await startedGoal();
  fs.writeFileSync(path.join(pixelFolder, "bot.json"), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(pixelFolder, "bot.json"), "utf8")), work: { limits: { perDay: 2 } } }));
  assert.equal((await tool("start_session", { task: "One.", project: "Driftwood" })).isError, false);
  const refused = await tool("start_session", { task: "Two.", project: "Driftwood" });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /New sessions for your goal wait for it to reset at midnight, and you're woken then/);
  const goal = (await goals())[0];
  const midnight = new Date(new Date().setHours(24, 0, 0, 0)).getTime();
  assert.deepEqual(goal.paused, [{ why: "your daily limit", until: midnight }]);
  await look(midnight + 1_000);
  assert.match(prompts.at(-1).text, /^\[Limit reset\] your daily limit has reset\. Carry on with the goal\./);
  assert.deepEqual((await goals())[0].paused, []);
});

test("a spend cap holds what spends until its period starts again, while the rest carries on", async () => {
  await startedGoal();
  assert.match((await tool("may_spend", { what: "ads", amount: 15 })).text, /^Yes/);
  assert.equal((await tool("goal_progress", { spent: { what: "ads", amount: 20 } })).isError, false);
  const held = await tool("may_spend", { what: "ads", amount: 5 });
  assert.match(held.text, /^No: only 0 USD is left until .*, when it starts again/);
  assert.ok(kept().spend[1].until > Date.now());
  assert.match((await tool("may_spend", { what: "driftwood.coffee", amount: 10.46 })).text, /^Yes/, "another line's cap is its own");
  assert.match((await tool("may_spend", { what: "a logo", amount: 50 })).text, /isn't one of the plan's spend lines/);
  // A day later (its period kept as yesterday's): it starts again from nothing.
  keep(goal => { goal.periods = goal.periods.map((each, at) => (at === 1 ? "2020-01-01" : each)); });
  await look();
  const ads = kept().spend[1];
  assert.deepEqual([ads.spent, ads.until], [0, undefined]);
  assert.match((await tool("may_spend", { what: "ads", amount: 5 })).text, /^Yes/);
});

test("what you pay for yourself, like a membership the plan needs you to join, is on the card as yours to do, never as the bot's spending", async () => {
  const membership = { text: "Apple Developer Program membership and App Store Connect access", detail: "99 USD a year", url: "https://developer.apple.com/programs/enroll/", button: "Join" };
  // A key you add for a service the bot then spends on is yours to add, the spending the bot's.
  const key = { text: "Add an OpenAI API key", url: "https://platform.openai.com/api-keys", button: "Add" };
  const said = await tool("propose_goal", { ...PLAN, checks: [...PLAN.checks, membership, key], spend: [{ what: "Apple Developer Program membership", cap: 99 }, { what: "OpenAI API", cap: 20, per: "month" }, ...PLAN.spend] });
  assert.match(said.text, /Apple Developer Program membership is the user's to pay/, "the bot hears it's not its to spend");
  const [card] = await goals();
  assert.deepEqual(card.spend.map(each => each.what), ["OpenAI API", "driftwood.coffee", "ads"], "only what the bot spends itself");
  assert.deepEqual(card.checks.filter(each => each.state === "needs" && each.by === "bot").map(each => each.text), ["Add a Cloudflare API token", membership.text, key.text], "the membership is under what needs you");

  // A plan where you pay for all there is to pay: it spends nothing, and isn't told it may.
  await tool("propose_goal", { ...PLAN, checks: [membership], spend: [{ what: "Apple Developer Program", cap: 99, per: "goal" }] });
  const [only] = await goals();
  assert.deepEqual(only.spend, []);
  assert.equal((await route("POST", `kuvo/work/goals/${only.id}`, { action: "start" })).status, 200);
  assert.match(prompts.at(-1).text, /Spend nothing\./);
  assert.match((await tool("may_spend", { what: "Apple Developer Program", amount: 99 })).text, /^No: .* isn't one of the plan's spend lines/);
});

test("the goal as it goes: tracks with real progress only, steps added as the plan changes, what waits for you told quietly (or waking you if you asked), whether you're here, and the report told once", async () => {
  await startedGoal();
  const moved = await tool("goal_progress", { steps: [{ step: 1, state: "done" }, { step: 2, state: "doing", progress: 0.5, note: "comparing registrars" }], add: ["Write the launch post"] });
  assert.equal(moved.isError, false, moved.text);
  assert.match(moved.text, /The user is away now/);
  assert.equal((await tool("goal_progress", { step: 2, progress: 1.5 })).isError, true, "progress is a share, never a guess past it");
  const bare = await tool("goal_progress", { step: 2, progress: 0.6 });
  assert.equal(bare.isError, true, "a share with nothing counted: the user sees the count, never a bare percentage");
  assert.match(bare.text, /note/);
  assert.equal((await tool("goal_progress", { steps: [{ step: 1, state: "done" }, { step: 99, state: "done" }], watching: ["DNS"] })).isError, true);
  let goal = (await goals())[0];
  assert.deepEqual(goal.steps.map(each => [each.state, each.progress ?? null]), [["done", 1], ["doing", 0.5], ["todo", null], ["todo", null], ["todo", null], ["todo", null]]);
  assert.equal(goal.steps[5].text, "Write the launch post");
  assert.ok(goal.steps[0].began <= goal.steps[0].ended && goal.steps[1].began && goal.steps[1].ended === undefined, "when each began and ended, for the time axis");
  assert.equal(goal.steps[2].began, undefined, "not begun yet");
  assert.deepEqual(goal.watching, [], "nothing's kept of a call that's wrong somewhere");

  await tool("goal_progress", { waiting: { kind: "you", text: "Finish Stripe's identity check", url: "https://dashboard.stripe.com" }, watching: ["DNS for driftwood.coffee"] });
  await link.lookAtGoals(tell, target, { here: () => true });
  assert.deepEqual([told[0].category, told[0].subtitle, told[0].body, told[0].data.quiet], ["blocked", "Needs you", "Finish Stripe's identity check", "1"]);
  assert.match((await tool("goal_progress", { steps: [{ step: 3, state: "doing" }] })).text, /The user is here now/);

  const finished = await tool("finish_goal", { report: "One thing first: Stripe still needs your identity check. driftwood.coffee is live." });
  assert.equal(finished.isError, false);
  goal = (await goals())[0];
  assert.equal(goal.state, "done");
  await look();
  await look();
  const reports = told.filter(each => each.category === "report");
  assert.equal(reports.length, 1, "the report is told once");
  assert.deepEqual([reports[0].title, reports[0].subtitle], ["Pixel finished Driftwood's landing page", "1 thing needs you"]);
});

test("a long goal's digest says how it goes as often as you asked, with how long it waited at limits", async () => {
  const started = await startedGoal({ digest: "day" });
  keep(goal => { goal.started = Date.now() - 2 * 86_400_000 - 60_000; goal.waited = 2 * 3_600_000; goal.steps[0].state = "done"; });
  await look();
  const [digest] = told.filter(each => each.category === "report");
  assert.match(digest.body, /^Day 2: 1 step done \(1 of 5 in all\), waited 2 h at limits in all\./);
  assert.equal(digest.data.quiet, "1");
  assert.equal((await goals())[0].lastDigest.text, digest.body);
  await look();
  assert.equal(told.filter(each => each.category === "report").length, 1, "once a day");
  assert.equal(started.digest, "day");
});

test("an end you set has the bot wrap up and report; if it doesn't, the box ends it with a word, never mid-step otherwise", async () => {
  await startedGoal({ ends: Date.now() + 60_000 });
  const now = Date.now() + 120_000;
  await look(now);
  assert.match(prompts.at(-1).text, /^\[Goal's end\] The end the user set has come/);
  assert.equal((await goals())[0].state, "running");
  active.add("ses_site");
  await look(now + 3 * 3_600_000);
  const goal = (await goals())[0];
  assert.equal(goal.state, "stopped");
  assert.match(goal.report, /reached the end you set/);
  assert.ok(interrupted.includes("ses_site"));
});

test("an end you move later after it came is a new end: the bot works on, and is told to wrap up once that one comes", async () => {
  const goal = await startedGoal({ ends: Date.now() + 60_000 });
  await look(Date.now() + 120_000);
  assert.match(prompts.at(-1).text, /^\[Goal's end\] The end the user set has come/);
  const later = Date.now() + 2 * 86_400_000;
  const changed = await route("POST", `kuvo/work/goals/${goal.id}`, { action: "change", ends: later });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  const told = prompts.length;
  await look(later + 60_000);
  assert.equal((await goals())[0].state, "running", "not ended at once, with no word");
  assert.ok(prompts.slice(told).some(each => /^\[Goal's end\] The end the user set has come/.test(each.text)), "told to wrap up at the new end");
});

test("Stop ends the goal: its sessions and the bot's own turn stop", async () => {
  const goal = await startedGoal();
  active.add("ses_site");
  active.add("ses_pixel");
  const stopped = await route("POST", `kuvo/work/goals/${goal.id}`, { action: "stop" });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.goal.state, "stopped");
  assert.ok(interrupted.includes("ses_site"));
  assert.ok(interrupted.includes("ses_pixel"));
  assert.equal((await tool("goal_progress", { step: 1, state: "done" })).isError, true);
});

// The conversation's goal as the agents' bridge says it changed (`kuvo.goal.updated`), which it
// does whichever app pressed Pause or Resume.
const goalEvent = (session, state, pausedBy, note = pausedBy === "you" ? "You paused it." : undefined) => ({ type: "kuvo.goal.updated", data: { sessionID: session, goal: { session, state, ...(pausedBy ? { pausedBy } : {}), ...(note ? { note } : {}) } } });

test("Pause, from any app, stops the bot's turn and its goal's sessions at once, keeping what was said; nothing new starts, not even a reminder, until Resume, which has it carry on from its plan", async () => {
  await startedGoal();
  active.add("ses_site");
  active.add("ses_pixel");
  const before = prompts.length;
  const holds = link.goalHolds(target);
  await holds(goalEvent("ses_pixel", "paused", "you"));
  assert.ok(interrupted.includes("ses_pixel"), "the bot's turn under way stops");
  assert.ok(interrupted.includes("ses_site"), "and the goal's sessions");
  assert.equal(link.queueOf("ses_pixel").paused, true, "its conversation shows it stopped, as Stop does");
  // A long while with nothing at work: no reminder goes, nor waits to go.
  const now = Date.now();
  await look(now);
  await look(now + 3 * 3_600_000);
  assert.deepEqual(prompts.slice(before), []);
  assert.deepEqual(link.queueOf("ses_pixel").waiting ?? [], []);
  await holds(goalEvent("ses_pixel", "working"));
  assert.equal(link.queueOf("ses_pixel").paused, false);
  const sent = prompts.slice(before);
  assert.deepEqual(sent.map(each => each.metadata?.kuvo?.note?.line), ["Goal resumed"], "told once to carry on from the plan, and nothing else");
  assert.equal(sent[0].to, "ses_pixel");
  assert.match(sent[0].text, /goal_progress/);
});

test("while you have a goal paused, none of its sessions starts another, however one of them is woken; the bot still starts one you ask it for in its chat, not one a letter asks for, and once you resume the goal, they can again", async () => {
  await startedGoal();
  await tool("start_session", { task: "Build the site.", project: "Driftwood", step: 1 });
  const site = made[0].id;
  sessions.get(site).metadata = { kuvo: { startedBy: "ses_pixel", by, depth: 1 } };
  const holds = link.goalHolds(target);
  await holds(goalEvent("ses_pixel", "paused", "you"));
  // The site's session, idle as you paused, woken by a letter.
  const refused = await tool("start_session", { task: "Write the copy.", project: "Driftwood" }, { session: site });
  assert.equal(refused.isError, true, refused.text);
  assert.match(refused.text, /paused/);
  assert.equal(made.length, 1, "nothing new started");
  // The bot's own conversation, woken by another agent's letter: nor does it.
  written.set("ses_pixel", ["[Message from Scout · ses_scout] (To answer, use send_message to ses_scout.)\n\nShall I start on the copy?"]);
  const woken = await tool("start_session", { task: "Write the copy.", project: "Driftwood" });
  assert.equal(woken.isError, true, woken.text);
  assert.equal(made.length, 1);
  // You, in the bot's own conversation meanwhile, asking it for something: it starts that.
  // (A long turn: it read and tried a good while before starting it.)
  written.set("ses_pixel", ["Check the logo looks right on dark backgrounds.", ...written.get("ses_pixel")]);
  stepsSince.set("ses_pixel", 150);
  const asked = await tool("start_session", { task: "Check the logo.", project: "Driftwood" });
  assert.equal(asked.isError, false, asked.text);
  assert.equal(made.length, 2);
  await holds(goalEvent("ses_pixel", "working"));
  const started = await tool("start_session", { task: "Write the copy.", project: "Driftwood" }, { session: site });
  assert.equal(started.isError, false, started.text);
  assert.equal(made.length, 3);
});

test("a goal you paused stays paused when the bridge can't say how it is for a moment: it isn't set again, so it isn't resumed", async () => {
  await startedGoal();
  const holds = link.goalHolds(target);
  loops.set("ses_pixel", goalEvent("ses_pixel", "paused", "you").data.goal);
  await holds(goalEvent("ses_pixel", "paused", "you"));
  const before = prompts.length;
  readsFailing = 1;
  await look();
  assert.equal(loops.get("ses_pixel").state, "paused", "the conversation's goal is as you left it");
  await look();
  assert.equal(loops.get("ses_pixel").state, "paused");
  assert.deepEqual(prompts.slice(before), [], "and the bot isn't told to carry on");
});

test("Pause on a conversation's own goal stops its turn and holds it until Resume", async () => {
  active.add("ses_site");
  const holds = link.goalHolds(target);
  await holds(goalEvent("ses_site", "paused", "you"));
  assert.deepEqual(interrupted, ["ses_site"]);
  assert.equal(link.queueOf("ses_site").paused, true);
  await holds(goalEvent("ses_site", "working"));
  assert.equal(link.queueOf("ses_site").paused, false);
  // A pause at a limit, or as a turn was stopped, isn't its Pause: nothing more is held.
  await holds(goalEvent("ses_site", "paused", "limit"));
  await holds(goalEvent("ses_site", "paused", "you", "The turn was stopped."));
  assert.equal(link.queueOf("ses_site").paused, false);
  assert.deepEqual(interrupted, ["ses_site"]);
  assert.deepEqual(prompts, []);
});

// A pause goes on from where it was: unlike Stop, what's waiting on its timers stays, and isn't stopped.
test("pausing a goal stops its sessions' turns and leaves their wake-ups, and nothing marks them stopped", async () => {
  await startedGoal();
  active.add("ses_site");
  const wakes = path.join(home, "wakes", "ses_site", "wakes");
  fs.mkdirSync(wakes, { recursive: true });
  const wake = path.join(wakes, `${Math.floor(Date.now() / 1000) + 3600}-abc`);
  fs.writeFileSync(wake, "Look again.");
  await link.goalHolds(target)(goalEvent("ses_pixel", "paused", "you"));
  assert.ok(interrupted.includes("ses_site"), "its turn stops");
  assert.equal(fs.existsSync(wake), true, "its wake-up stays");
  assert.equal(link.readStopped().ses_site, undefined);
  fs.rmSync(path.join(home, "wakes", "ses_site"), { recursive: true, force: true });
});

// The box restarting (or its stream from the bridge dropping) while a goal is paused: what it held
// stays held, and once it's found the bridge again, a goal resumed meanwhile goes on.
test("a goal paused before the box restarted stays held, and goes on once it finds the goal resumed meanwhile", async () => {
  await startedGoal();
  active.add("ses_site");
  active.add("ses_pixel");
  const before = prompts.length;
  await link.goalHolds(target)(goalEvent("ses_pixel", "paused", "you"));
  const stops = interrupted.length;
  // Started again: the bridge says it again, and nothing more is stopped.
  await link.goalHolds(target)(goalEvent("ses_pixel", "paused", "you"));
  assert.equal(interrupted.length, stops);
  await look(Date.now() + 3 * 3_600_000);
  assert.deepEqual(prompts.slice(before), [], "held through the restart: no reminder");
  // Resumed while it was down.
  loops.set("ses_pixel", goalEvent("ses_pixel", "working").data.goal);
  const holds = link.goalHolds(target);
  await link.settleGoalHolds({ port: bridge.address().port, password: "p" }, holds);
  assert.equal(link.queueOf("ses_pixel").paused, false);
  assert.deepEqual(prompts.slice(before).map(each => each.metadata?.kuvo?.note?.line), ["Goal resumed"]);
});

// Paused from the Mac (straight to the bridge) while the box wasn't listening: it restarted, or its
// stream dropped, and the bridge's word went by unheard.
test("a goal paused while the box wasn't listening is held once it finds the bridge again: its turn stops, and no reminder goes", async () => {
  await startedGoal();
  active.add("ses_site");
  active.add("ses_pixel");
  const before = prompts.length;
  loops.set("ses_pixel", goalEvent("ses_pixel", "paused", "you").data.goal);
  await link.settleGoalHolds({ port: bridge.address().port, password: "p" }, link.goalHolds(target));
  assert.ok(interrupted.includes("ses_pixel"), "the bot's turn under way stops");
  assert.ok(interrupted.includes("ses_site"), "and the goal's sessions");
  assert.equal(link.queueOf("ses_pixel").paused, true);
  active.clear();
  await look(Date.now() + 3 * 3_600_000);
  assert.deepEqual(prompts.slice(before), [], "held: no reminder");
});

test("a conversation whose goal you paused, then carried on in, isn't stopped again when the box finds the bridge again", async () => {
  active.add("ses_site");
  await link.goalHolds(target)(goalEvent("ses_site", "paused", "you"));
  // Resume on the conversation itself (not its goal): it goes on, its goal still paused.
  assert.equal((await route("POST", "kuvo/sessions/ses_site/queue/resume")).status, 200);
  loops.set("ses_site", goalEvent("ses_site", "paused", "you").data.goal);
  active.add("ses_site");
  const stops = interrupted.length;
  await link.settleGoalHolds({ port: bridge.address().port, password: "p" }, link.goalHolds(target));
  assert.equal(interrupted.length, stops, "its turn under way goes on");
  assert.equal(link.queueOf("ses_site").paused, false);
});

test("a conversation whose goal is taken away while paused stays stopped for you to Resume, from then on as any", async () => {
  active.add("ses_site");
  await link.goalHolds(target)(goalEvent("ses_site", "paused", "you"));
  assert.equal(link.queueOf("ses_site").heldFor, "goal");
  // Cleared as the box listened, or while it was down.
  const holds = link.goalHolds(target);
  await holds({ type: "kuvo.goal.updated", data: { sessionID: "ses_site", goal: null } });
  assert.equal(link.queueOf("ses_site").paused, true);
  assert.equal(link.queueOf("ses_site").heldFor, undefined);
  await link.goalHolds(target)(goalEvent("ses_site", "paused", "you"));
  await link.settleGoalHolds({ port: bridge.address().port, password: "p" }, holds);
  assert.equal(link.queueOf("ses_site").heldFor, undefined, "no goal at the bridge: no longer held for it");
  assert.equal(link.queueOf("ses_site").paused, true);
  // A goal set on it later going on isn't what holds it.
  await holds(goalEvent("ses_site", "working"));
  assert.equal(link.queueOf("ses_site").paused, true);
  assert.deepEqual(prompts, []);
});

test("for a goal, a session the bot starts is told no one may be watching, a project the plan names is made without asking, and nothing asks that its mode wouldn't", async () => {
  await startedGoal({});
  write(path.join(home, "box", "work.json"), JSON.stringify({ projectsFolder: developer }));
  const started = await tool("start_session", { task: "Write the landing page copy.", project: "Driftwood" });
  assert.equal(started.isError, false, started.text);
  assert.match(prompts.find(each => each.to === made[0].id).text, /part of a goal the user may not be watching/);
  for (const command of ["vercel --prod", "npm publish", "gh pr create --fill"]) assert.equal(effectOf(made[0].permissions, "shell", command), "allow", command);
  const own = JSON.stringify(sessions.get("ses_pixel").permissions);
  await look();
  assert.equal(JSON.stringify(sessions.get("ses_pixel").permissions), own, "its own conversation's rules left as they are while the goal runs");
  const planned = await tool("make_project", { name: "Storefront" });
  assert.equal(planned.isError, false, planned.text);
  assert.ok(fs.existsSync(path.join(developer, "storefront", ".git")), "made at once: you approved it with the goal");

  const [goal] = await goals();
  await route("POST", `kuvo/work/goals/${goal.id}`, { action: "stop" });
  await startedGoal();
  await tool("start_session", { task: "Deploy the site.", project: "Driftwood" });
  assert.equal(effectOf(made.at(-1).permissions, "shell", "vercel --prod"), "allow");
});

test("a plan from more than a day ago can't start", async () => {
  await tool("propose_goal", PLAN);
  keep(goal => { goal.proposed = Date.now() - 25 * 3_600_000; });
  const start = await route("POST", `kuvo/work/goals/${kept().id}`, { action: "start" });
  assert.equal(start.status, 400);
  assert.match(start.body.message, /more than a day ago/);
});

test("the real app's box never works alone on the tests' say-so", async () => {
  const realHome = path.join(home, "Library", "run.kuvo.code", "box");
  write(path.join(realHome, "bots", "bot_pixel00001", "bot.json"), fs.readFileSync(path.join(pixelFolder, "bot.json")));
  write(path.join(realHome, "bots", "bot_pixel00001", "session"), "ses_pixel");
  write(path.join(realHome, "run", "work", "goals.json"), JSON.stringify({ goals: [{ id: "goal_r", bot: "bot_pixel00001", name: "Pixel", session: "ses_pixel", goal: "x", state: "proposed", steps: [{ id: "s1", text: "a", state: "todo" }], checks: [], spend: [], public: [], projects: [], wake: false, digest: "none", proposed: Date.now(), waiting: [], paused: [], waited: 0, watching: [] }] }));
  const answer = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, "box", "route"], { env: { ...process.env, KUVO_HOME: realHome, HOME: home, TMPDIR: home, KUVO_TEST_SANDBOX_ON: "1" }, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.on("error", reject);
    child.on("close", () => resolve(JSON.parse(out.trim().split("\n").pop())));
    child.stdin.end(JSON.stringify({ method: "GET", path: "kuvo/work/goals" }));
  });
  assert.equal(JSON.parse(answer.body).goals[0].alone, false);
});

// The engine's rules as it applies them: the last that matches wins, and none matching lets it
// through.
const effectOf = (rules, action, resource) => {
  let effect = "allow";
  for (const rule of rules) if ((rule.action === action || rule.action === "*") && new RegExp(`^${rule.resource.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[\\s\\S]*").replace(/\?/g, ".")}$`).test(resource)) effect = rule.effect;
  return effect;
};

test("a session a bot starts on Approve All goes ahead with all its work as any conversation on it: its project's folders stay its own, and your Don't Allow stays", async () => {
  sessions.get("ses_pixel").permissions = [
    { action: "shell", resource: "*", effect: "allow" },
    { action: "external_directory", resource: "*", effect: "deny" },
    { action: "shell", resource: "git push *", effect: "deny" },
  ];
  // Driftwood spans a second folder, which its sessions work in as in its own.
  const shared = path.join(home, "work", "shared");
  fs.mkdirSync(shared, { recursive: true });
  write(path.join(home, "box", "projects.json"), JSON.stringify({ projects: [{ directory: driftwood, name: "Driftwood", folders: [shared] }] }));
  const started = await tool("start_session", { task: "Tidy the repo.", project: "Driftwood" });
  assert.equal(started.isError, false, started.text);
  const rules = made[0].permissions;
  for (const command of ["ls", "npm test", "git status", "git config --get user.email"]) assert.equal(effectOf(rules, "shell", command), "allow", command);
  assert.equal(effectOf(rules, "edit", path.join(driftwood, "src/app.ts")), "allow");
  // Deletes, git's settings and root are the sandbox's to hold, as Claude Code's auto mode leaves them.
  for (const command of ["rm notes.md", "git clean -fd", "git -C repo config core.hooksPath x"]) assert.equal(effectOf(rules, "shell", command), "allow", command);
  for (const command of ["gh pr create --fill", "gh issue create", "stripe charges create --amount 500", "sendmail ada@example.com", "useradd pixel", "vercel --prod"]) assert.equal(effectOf(rules, "shell", command), "allow", command);
  assert.equal(effectOf(rules, "shell", "git push origin main"), "deny", "what you don't allow stays not allowed");
  assert.equal(effectOf(rules, "external_directory", path.join(shared, "notes.md")), "allow", "its project's other folder stays its own, after the Don't Allow of others");
  assert.equal(effectOf(rules, "external_directory", "/etc/hosts"), "deny");
});

test("the goal is the conversation's own goal: set as it starts (briefed by the plan, not twice), set again if the bridge lost it, and taken away once it ends", async () => {
  const goal = await startedGoal();
  assert.deepEqual([loops.get("ses_pixel").long, /Launch a landing page/.test(loops.get("ses_pixel").condition)], [true, true]);
  // The bridge started over without it: the box's watch sets it again.
  loops.clear();
  await look();
  assert.ok(loops.has("ses_pixel"));
  // The bot's own turn waits for a model's limit: shown as the goal's pause.
  const resumesAt = Date.now() + 3_600_000;
  loops.set("ses_pixel", { ...loops.get("ses_pixel"), state: "paused", pausedBy: "limit", resumesAt });
  await look();
  assert.deepEqual((await goals())[0].paused, [{ why: "the model's limit", until: resumesAt, session: "ses_pixel" }]);
  loops.set("ses_pixel", { ...loops.get("ses_pixel"), state: "working", pausedBy: undefined, resumesAt: undefined });
  await look();
  assert.deepEqual((await goals())[0].paused, []);
  await route("POST", `kuvo/work/goals/${goal.id}`, { action: "stop" });
  assert.equal(loops.has("ses_pixel"), false, "stopped, its conversation's goal goes too");
});

test("a goal's conversation Auto's reviewer paused stays paused on its card, whatever the bot's turn does at a model's limit, until you resume it", async () => {
  const goal = await startedGoal();
  link.pauseGoal(goal.bot, { why: link.REVIEW_PAUSE, session: "ses_pixel" });
  const paused = [{ why: link.REVIEW_PAUSE, session: "ses_pixel" }];
  await look();
  assert.deepEqual((await goals())[0].paused, paused);
  // A limit on its turn, and the turn going on again after, leave it as it is.
  loops.set("ses_pixel", { ...loops.get("ses_pixel"), state: "paused", pausedBy: "limit", resumesAt: Date.now() + 3_600_000 });
  await look();
  assert.deepEqual((await goals())[0].paused, paused);
  loops.set("ses_pixel", { ...loops.get("ses_pixel"), state: "working", pausedBy: undefined, resumesAt: undefined });
  await look();
  assert.deepEqual((await goals())[0].paused, paused);
  // You resume Auto there: off the card.
  assert.equal((await route("POST", "kuvo/sessions/ses_pixel/decisions", { resume: true })).status, 200);
  assert.deepEqual((await goals())[0].paused, []);
});

const nudges = () => prompts.filter(each => each.to === "ses_pixel" && each.text.startsWith("[Goal] Nothing of the goal is at work"));

// A dev server a session left up isn't the goal at work: it would never be nudged on, or paused.
const leftRunning = (session, since) => fs.writeFileSync(path.join(home, "run", "work", "background.json"), JSON.stringify({ engine: { folders: [], sessions: { [session]: { commands: [{ id: "sh_dev", command: "npm run dev", started: since }], subagents: [], tasks: [] } } } }));
const forgetLeftRunning = () => fs.rmSync(path.join(home, "run", "work", "background.json"), { force: true });

test("what a goal's session left running holds off a nudge only for a while", async () => {
  await startedGoal();
  await tool("start_session", { task: "Build the site.", project: "Driftwood", step: 1 });
  const site = made[0].id;
  const now = Date.now();
  await look(now);
  // A command just started: it's at work, and nobody's reminded.
  leftRunning(site, now + 10 * 60_000);
  await look(now + 11 * 60_000);
  assert.equal(nudges().length, 0);
  // Still up long after: that's a dev server, not the goal going on.
  leftRunning(site, now);
  await look(now + 42 * 60_000);
  await look(now + 53 * 60_000);
  forgetLeftRunning();
  assert.equal(nudges().length, 1);
});

test("a goal's session whose finish waits on its build, however long, is at work: no nudge until its lead hears", async () => {
  await startedGoal();
  await tool("start_session", { task: "Build the apps.", project: "Driftwood", step: 1 });
  const site = made[0].id;
  const now = Date.now();
  await look(now);
  // (#553: its finish is held on the build, which nobody's been told of yet.)
  leftRunning(site, now);
  fs.writeFileSync(path.join(home, "run", "work", "told.json"), JSON.stringify({ since: now, sessions: {}, waiting: { [site]: { from: "engine", at: now } } }));
  await look(now + 42 * 60_000);
  await look(now + 90 * 60_000);
  forgetLeftRunning();
  fs.rmSync(path.join(home, "run", "work", "told.json"), { force: true });
  assert.equal(nudges().length, 0);
});

test("a turn that failed at a limit pauses the goal, with what its session left running still up", async () => {
  await startedGoal();
  await tool("start_session", { task: "Build the site.", project: "Driftwood", step: 1 });
  const site = made[0].id;
  sessions.get(site).model = { providerID: "anthropic", id: "claude-opus-5-5" };
  sessions.get(site).metadata = { kuvo: { startedBy: "ses_pixel", by, depth: 1 } };
  failures.set(site, "You've hit your usage limit. Your limit resets in 2h.");
  const now = Date.now();
  leftRunning(site, now);
  await look(now);
  forgetLeftRunning();
  assert.equal((await goals())[0].paused.length, 1);
});

test("with nothing of the goal at work, the bot is told to carry on after a while; told once with nothing changing after, it isn't told again until something does, and never while all that's left waits for you", async () => {
  await startedGoal();
  const now = Date.now();
  await look(now);
  await look(now + 5 * 60_000);
  assert.equal(nudges().length, 0, "a quiet moment isn't a stall");
  await look(now + 11 * 60_000);
  assert.equal(nudges().length, 1);
  assert.equal(nudges()[0].metadata?.kuvo?.note?.line, "Reminded to carry on");
  // It answered and changed nothing: never told again for the same plan, over days.
  for (const hours of [1, 3, 8, 24, 48, 96]) await look(now + hours * 3_600_000);
  assert.equal(nudges().length, 1, "a bot is never looped");
  // Something changes, then it goes quiet again: told once more.
  await tool("goal_progress", { steps: [{ step: 1, state: "doing" }] });
  const later = now + 97 * 3_600_000;
  await look(later);
  await look(later + 11 * 60_000);
  assert.equal(nudges().length, 2);
  // All that's left waits for you: nothing to tell it.
  await tool("goal_progress", { steps: [1, 2, 3, 4, 5].map(step => ({ step, state: "waiting" })) });
  await look(later + 10 * 3_600_000);
  await look(later + 30 * 3_600_000);
  assert.equal(nudges().length, 2);
});

test("a look at a running goal that finds nothing new tells no one: the apps following the goals aren't sent them again, and the box's own watch rests until its next look", async () => {
  await startedGoal();
  const now = Date.now();
  await look(now);
  let toldFollowers = 0;
  const follower = () => { toldFollowers += 1; };
  link.goalFollowers.add(follower);
  try {
    await look(now + 1000);
    await look(now + 2000);
    assert.equal(toldFollowers, 0);
    // Something new is told.
    await look(now + 11 * 60_000);
    assert.equal(nudges().length, 1);
    assert.ok(toldFollowers > 0);
  } finally {
    link.goalFollowers.delete(follower);
  }
});

// A wake-up of the bot's, as kuvo-wake keeps it: a file in its folder named for when it's due.
const wakeUp = (due, note = "Write this week's summary.") => write(path.join(pixelFolder, "wakes", `${Math.round(due / 1000)}-wk${String(due).slice(-6)}`), note);

test("a goal whose next step waits two days for a wake-up isn't nudged meanwhile, shows when it goes on next, and is nudged after only if the wake-up started nothing", async () => {
  await startedGoal();
  await tool("goal_progress", { steps: [{ step: 1, state: "done" }] });
  const now = Date.now();
  const monday = now + 2 * 86_400_000;
  wakeUp(monday);
  for (const hours of [0, 1, 6, 12, 24, 36, 47]) await look(now + hours * 3_600_000);
  assert.equal(nudges().length, 0, "nothing goes to a bot that set itself a time");
  assert.equal((await goals())[0].next, Math.round(monday / 1000) * 1000, "the goal says when it goes on next");
  // The wake-up comes and starts work: nothing to tell it, and nothing waits on a time now.
  fs.rmSync(path.join(pixelFolder, "wakes"), { recursive: true });
  active.add("ses_pixel");
  await look(monday + 60_000);
  active.delete("ses_pixel");
  assert.equal((await goals())[0].next, undefined);
  await tool("goal_progress", { steps: [{ step: 2, state: "doing" }] });
  // Another week's wake-up, which comes and starts nothing: told to carry on a while after it.
  const next = monday + 7 * 86_400_000;
  wakeUp(next);
  await look(monday + 2 * 3_600_000);
  await look(next - 60_000);
  assert.equal(nudges().length, 0);
  fs.rmSync(path.join(pixelFolder, "wakes"), { recursive: true });
  await look(next + 5 * 60_000);
  assert.equal(nudges().length, 0, "the wake-up has its moment");
  await look(next + 11 * 60_000);
  assert.equal(nudges().length, 1);
});

test("a bot told to carry on that only sets a wake-up, changing nothing of the plan, is told once more if the wake-up starts nothing", async () => {
  await startedGoal();
  const now = Date.now();
  await look(now);
  await look(now + 11 * 60_000);
  assert.equal(nudges().length, 1);
  const tomorrow = now + 86_400_000;
  wakeUp(tomorrow);
  await look(now + 12 * 3_600_000);
  assert.equal(nudges().length, 1);
  fs.rmSync(path.join(pixelFolder, "wakes"), { recursive: true });
  await look(tomorrow + 5 * 60_000);
  assert.equal(nudges().length, 1, "the wake-up has its moment");
  await look(tomorrow + 11 * 60_000);
  assert.equal(nudges().length, 2, "its time came and went: told again, as soon as the first time");
  for (const hours of [1, 6, 24]) await look(tomorrow + hours * 3_600_000);
  assert.equal(nudges().length, 2, "and then not again for the same plan");
});

test("a wake-up that comes back (a daily check) doesn't hold back a goal with work to do now; once all that's left is put off, it's when the goal goes on next", async () => {
  await startedGoal();
  const now = Date.now();
  const tomorrow = now + 86_400_000;
  write(path.join(pixelFolder, "wakes", `${Math.round(tomorrow / 1000)}-wkdaily-1d`), "Check the inbox.");
  await look(now);
  await look(now + 11 * 60_000);
  assert.equal(nudges().length, 1, "work it can do now isn't put off by a check that comes daily");
  assert.equal((await goals())[0].next, undefined);
  const monday = new Date(now + 3 * 86_400_000).toISOString();
  await tool("goal_progress", { steps: [1, 2, 3, 4, 5].map(step => ({ step, until: monday })) });
  await look(now + 3_600_000);
  assert.equal((await goals())[0].next, Math.round(tomorrow / 1000) * 1000, "the soonest time it's woken");
});

test("a wait taken away (the wake-up cancelled to do it today) doesn't hold the nudge back until the old time", async () => {
  await startedGoal();
  const now = Date.now();
  const monday = now + 2 * 86_400_000;
  wakeUp(monday);
  await look(now);
  await look(now + 3_600_000);
  assert.ok((await goals())[0].next);
  fs.rmSync(path.join(pixelFolder, "wakes"), { recursive: true });
  await look(now + 2 * 3_600_000);
  assert.equal((await goals())[0].next, undefined);
  await look(now + 2 * 3_600_000 + 11 * 60_000);
  assert.equal(nudges().length, 1, "told to carry on a while after, not on Monday");
});

test("a bot told to carry on whose turn failed (not at a limit) is told again later, though the plan's the same", async () => {
  await startedGoal();
  const now = Date.now();
  await look(now);
  await look(now + 11 * 60_000);
  assert.equal(nudges().length, 1);
  failures.set("ses_pixel", "The provider answered 500.");
  await look(now + 20 * 60_000);
  assert.equal(nudges().length, 1, "after a while, as before");
  await look(now + 42 * 60_000);
  assert.equal(nudges().length, 2);
  failures.delete("ses_pixel");
  for (const hours of [2, 12, 48]) await look(now + hours * 3_600_000);
  assert.equal(nudges().length, 2, "answered, changing nothing: not again");
});

test("a step put off with a time in seconds since 1970 (as wake-ups give it) is put off until then", async () => {
  await startedGoal();
  const monday = Math.round((Date.now() + 2 * 86_400_000) / 1000);
  const put = await tool("goal_progress", { steps: [{ step: 1, until: monday }] });
  assert.equal(put.isError, false, put.text);
  assert.equal((await goals())[0].steps[0].until, monday * 1000);
});

test("a step put off until a time with goal_progress waits for it: no nudges before, the plan shows when, and once the time comes it's the bot's to carry on", async () => {
  await startedGoal();
  const monday = new Date(Date.now() + 2 * 86_400_000);
  monday.setSeconds(0, 0);
  const put = await tool("goal_progress", { steps: [{ step: 1, state: "done" }, ...[2, 3, 4, 5].map(step => ({ step, until: monday.toISOString() }))] });
  assert.equal(put.isError, false, put.text);
  const [goal] = await goals();
  assert.deepEqual(goal.steps.slice(1).map(step => [step.state, step.until]), [2, 3, 4, 5].map(() => ["todo", monday.getTime()]));
  assert.equal(goal.next, undefined, "shown from the box's next look");
  const now = Date.now();
  for (const hours of [0, 1, 12, 24, 47]) await look(now + hours * 3_600_000);
  assert.equal(nudges().length, 0);
  assert.equal((await goals())[0].next, monday.getTime());
  await look(monday.getTime() + 5 * 60_000);
  assert.equal(nudges().length, 0);
  await look(monday.getTime() + 11 * 60_000);
  assert.equal(nudges().length, 1, "the time came and nothing started: told to carry on");
  assert.equal((await tool("goal_progress", { steps: [{ step: 2, until: "next Monday" }] })).isError, true, "a time it can read");
});

test("only the goal's own sessions are its: an old session that failed at a limit isn't brought back", async () => {
  sessions.get("ses_site").time = { created: Date.now() - 86_400_000, updated: Date.now() - 86_400_000 };
  sessions.get("ses_site").model = { providerID: "anthropic", id: "claude-opus-5-5" };
  failures.set("ses_site", "You've hit your usage limit. Your limit resets in 1h.");
  await startedGoal();
  await look();
  await look(Date.now() + 2 * 3_600_000);
  assert.deepEqual((await goals())[0].paused, []);
  assert.equal(prompts.filter(each => each.to === "ses_site").length, 0);
});

test("what waits for you goes once it's dealt with, by the bot or by you, and you can raise a cap on the goal", async () => {
  const goal = await startedGoal();
  await tool("goal_progress", { waiting: { kind: "you", text: "Finish Stripe's identity check" } });
  await tool("goal_progress", { waiting: { kind: "judgment", text: "Is the logo too close to Blue Bottle's?" } });
  await tool("goal_progress", { resolved: ["finish stripe's identity check"] });
  let [current] = await goals();
  assert.deepEqual(current.waiting.map(each => each.text), ["Is the logo too close to Blue Bottle's?"]);
  const cleared = await route("POST", `kuvo/work/goals/${goal.id}`, { action: "clear", waiting: current.waiting[0].id });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.body.goal.waiting, []);

  await tool("goal_progress", { spent: { what: "ads", amount: 20 } });
  assert.match((await tool("may_spend", { what: "ads", amount: 5 })).text, /^No/);
  const raised = await route("POST", `kuvo/work/goals/${goal.id}`, { action: "change", spend: [{}, { cap: 40 }] });
  assert.equal(raised.status, 200);
  assert.equal(raised.body.goal.spend[1].cap, 40);
  assert.match((await tool("may_spend", { what: "ads", amount: 5 })).text, /^Yes/, "raised past what's spent, it goes on");
  assert.match(prompts.at(-1).text, /^\[Goal changed\]/);
  // Spent on what isn't a spend line: kept for you.
  await tool("goal_progress", { spent: { what: "a logo", amount: 50 } });
  [current] = await goals();
  assert.ok(current.waiting.some(each => each.kind === "outside" && /a logo/.test(each.text)));
});

// ——— Interactive and Autopilot: how the bot runs it ———

// A question the bot (or a session of its work) asks with the question tool: which of three, one
// marked as its recommendation.
const QUESTION = { id: "frm_pick", title: "Direction", metadata: { kind: "question" }, fields: [{ key: "direction", type: "string", description: "Which direction should the site take?", options: [{ value: "warm", label: "Warm and roasty (Recommended)", description: "Scored best with the coffee crowd" }, { value: "minimal", label: "Minimal" }, { value: "playful", label: "Playful" }] }] };

test("a goal runs Interactive unless you start it on Autopilot, and you can switch while it runs: the bot is told how to run it each time, and nothing else about the goal changes", async () => {
  const interactive = await startedGoal();
  assert.equal(interactive.mode, "interactive", "Start as it was: Interactive");
  assert.deepEqual(interactive.decided, []);
  const started = prompts.at(-1).text;
  assert.match(started, /Interactive/);
  assert.match(started, /never .*approve your work/i, "never asks the user to approve its work");
  assert.equal((await route("POST", `kuvo/work/goals/${interactive.id}`, { action: "stop" })).status, 200);

  await tool("propose_goal", PLAN);
  const [card] = (await goals()).filter(each => each.state === "proposed");
  assert.equal(card.mode, "interactive", "a card shows the mode Start would use");
  assert.equal((await route("POST", `kuvo/work/goals/${card.id}`, { action: "start", mode: "solo" })).status, 400, "only interactive or autopilot");
  const autopilot = (await route("POST", `kuvo/work/goals/${card.id}`, { action: "start", mode: "autopilot" })).body.goal;
  assert.equal(autopilot.mode, "autopilot");
  const words = prompts.at(-1).text;
  assert.match(words, /Autopilot/);
  assert.match(words, /publish/i, "the plan's public steps are its to take: Start approved them");
  assert.match(words, /sign in/i, "it stops only at what only the user can do");
  assert.match(words, /\(Recommended\)/, "it marks its recommendation, which goes ahead at once");
  assert.match(words, /ads, up to 20 USD a day/, "what it may spend is the plan's, as on Interactive");
  assert.doesNotMatch(words, /Full Access|permission mode/i, "how it runs doesn't touch what its conversations may do");

  const count = prompts.length;
  const switched = await route("POST", `kuvo/work/goals/${autopilot.id}`, { action: "change", mode: "interactive" });
  assert.equal(switched.status, 200, JSON.stringify(switched.body));
  assert.equal(switched.body.goal.mode, "interactive");
  assert.deepEqual(switched.body.goal.spend.map(each => each.cap), [15, 20], "switching changes nothing else");
  assert.equal(prompts.length, count + 1);
  assert.match(prompts.at(-1).text, /^\[Goal changed\] .*Interactive/s);
  assert.deepEqual(prompts.at(-1).metadata, { kuvo: { note: { from: "Goal", line: "Now Interactive" } } });
  await route("POST", `kuvo/work/goals/${autopilot.id}`, { action: "change", mode: "interactive" });
  assert.equal(prompts.length, count + 1, "the same mode again tells it nothing");
  assert.equal((await route("POST", `kuvo/work/goals/${autopilot.id}`, { action: "change", mode: "autopilot" })).body.goal.mode, "autopilot");
  assert.match(prompts.at(-1).text, /^\[Goal changed\] .*Autopilot/s);
  assert.match((await tool("goal_progress", { steps: [{ step: 1, state: "doing" }] })).text, /Autopilot/, "goal_progress says how it runs, with whether you're here");
});

test("on Autopilot, a question asked with a recommendation goes ahead on it at once and is kept as a call the bot made, which you can confirm or change later; on Interactive it waits for you, and a question with no recommendation, or a permission, always does", async () => {
  // Interactive: the bot's own question waits for you, recommendation or not.
  const first = await startedGoal();
  forms.set("ses_pixel", [QUESTION]);
  await look();
  assert.deepEqual(answeredForms, []);
  assert.deepEqual((await goals())[0].waiting.map(each => each.kind), ["ask"]);
  await route("POST", `kuvo/work/goals/${first.id}`, { action: "change", mode: "autopilot" });

  // Switched to Autopilot: answered with its recommendation on the box's next look.
  const now = Date.now();
  await look(now);
  assert.deepEqual(answeredForms, [{ session: "ses_pixel", form: "frm_pick", answer: { direction: "warm" } }]);
  let [goal] = await goals();
  assert.deepEqual(goal.waiting, [], "it isn't waiting for you any more");
  assert.equal(goal.decided.length, 1);
  const [decided] = goal.decided;
  assert.deepEqual([decided.text, decided.choice, decided.why, decided.options, decided.session], ["Which direction should the site take?", "Warm and roasty", "Scored best with the coffee crowd", ["Warm and roasty", "Minimal", "Playful"], "ses_pixel"]);
  assert.equal(told.filter(each => each.category === "blocked").length, 0, "nothing to tell your phones: it went on");

  // A session's question goes the same way once the bot has had its moment to answer it; one with
  // no recommendation comes back declined, never answered for you, and a permission still waits.
  forms.set("ses_site", [{ ...QUESTION, id: "frm_site" }, { id: "frm_open", title: "Name", metadata: { kind: "question" }, fields: [{ key: "name", type: "string", description: "What should the newsletter be called?" }] }]);
  asked.set("ses_site", [{ id: "per_deploy", action: "shell", resources: ["vercel deploy --prod"] }]);
  await look(now);
  assert.equal(answeredForms.length, 1, "the bot answers its sessions first");
  await look(now + 5 * 60_000);
  assert.deepEqual(answeredForms.at(-1), { session: "ses_site", form: "frm_site", answer: { direction: "warm" } });
  assert.deepEqual(replied, [], "a permission is never answered for you: the conversation's mode decides those");
  [goal] = await goals();
  assert.deepEqual(forms.get("ses_site"), [], "nothing's left holding it");
  assert.equal(answeredForms.filter(each => each.form === "frm_open").length, 0, "nothing chosen for you");
  assert.deepEqual(goal.waiting.map(each => each.kind), ["ask"]);
  assert.ok(goal.waiting.some(each => /vercel deploy --prod/.test(each.text)));
  assert.equal(goal.decided.length, 2);

  // You confirm one (the bot isn't told), and change the other (it is, and redirects).
  const before = prompts.length;
  const confirmed = await route("POST", `kuvo/work/goals/${first.id}`, { action: "decided", decided: goal.decided[0].id, choice: "Warm and roasty" });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.goal.decided[0].yours.choice, "Warm and roasty");
  assert.equal(prompts.length, before, "a call you confirm needs no word to the bot");
  const changed = await route("POST", `kuvo/work/goals/${first.id}`, { action: "decided", decided: goal.decided[1].id, choice: "Minimal" });
  assert.equal(changed.body.goal.decided[1].yours.choice, "Minimal");
  assert.match(prompts.at(-1).text, /^\[Decision changed\] .*Which direction should the site take\?.*Minimal.*Warm and roasty/s);
  assert.deepEqual(prompts.at(-1).metadata, { kuvo: { note: { from: "Autopilot", line: "You picked Minimal" } } }, "told in the session that asked");
  assert.equal((await route("POST", `kuvo/work/goals/${first.id}`, { action: "decided", decided: "dec_none", choice: "Minimal" })).status, 404);
  assert.equal((await route("POST", `kuvo/work/goals/${first.id}`, { action: "decided", decided: goal.decided[1].id })).status, 400, "say which choice");
});

test("the bot keeps a call it made itself with goal_progress (what, its choice, why), shown with the goal as the box's are", async () => {
  await startedGoal({ mode: "autopilot" });
  const said = await tool("goal_progress", { decided: { text: "Which hosting?", choice: "Cloudflare Pages", why: "free tier covers it, and the domain's there", options: ["Cloudflare Pages", "Vercel", "Netlify"] } });
  assert.equal(said.isError, false, said.text);
  assert.match(said.text, /decided/i);
  const [goal] = await goals();
  assert.deepEqual(goal.decided.map(each => [each.text, each.choice, each.why, each.options]), [["Which hosting?", "Cloudflare Pages", "free tier covers it, and the domain's there", ["Cloudflare Pages", "Vercel", "Netlify"]]]);
  assert.equal(goal.decided[0].session, undefined);
  assert.equal((await tool("goal_progress", { decided: { text: "Which hosting?" } })).isError, true, "a call needs its choice");
});

// ——— Where it's done: the app's own icon, and the folders Start makes ———

// A PNG of `size` pixels, whole, as an icon theme has them.
function png(size) {
  const crc = bytes => {
    let c = ~0;
    for (const byte of bytes) {
      c ^= byte;
      for (let bit = 0; bit < 8; bit++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (kind, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length);
    head.write(kind, 4, "latin1");
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])));
    return Buffer.concat([head, data, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const rows = Buffer.alloc((size * 4 + 1) * size, 0x7f);
  for (let row = 0; row < size; row++) rows[row * (size * 4 + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
const isPNG = bytes => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

// A Linux computer's apps, as desktop entries and an icon theme in the test's own data folders
// (XDG_DATA_HOME, XDG_DATA_DIRS): Tidepool Studio, its icon a PNG at 48 and 128 pixels; Sketchpad,
// whose icon is an SVG alone.
function linuxApps() {
  const own = path.join(home, "xdg", "own");
  const system = path.join(home, "xdg", "system");
  fs.rmSync(path.join(home, "xdg"), { recursive: true, force: true });
  write(path.join(system, "applications", "tidepool.desktop"), "[Desktop Entry]\nType=Application\nName=Tidepool Studio\nIcon=tidepool\nExec=tidepool %U\n\n[Desktop Action new]\nName=New Window\n");
  write(path.join(system, "applications", "sketchpad.desktop"), "[Desktop Entry]\nType=Application\nName=Sketchpad\nIcon=sketchpad\n");
  for (const size of [48, 128]) write(path.join(system, "icons", "hicolor", `${size}x${size}`, "apps", "tidepool.png"), png(size));
  write(path.join(system, "icons", "hicolor", "scalable", "apps", "sketchpad.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  return { XDG_DATA_HOME: own, XDG_DATA_DIRS: system };
}

test("a step done in an app on this computer has that app's id, and its icon is the app's own, as a PNG; one that isn't here has none, and no icon", async () => {
  fs.rmSync(path.join(home, "apps"), { recursive: true, force: true });
  const mac = process.platform === "darwin";
  // On a Mac, Safari, which every Mac has; on Linux, an app among the test's own desktop entries.
  const env = mac ? {} : linuxApps();
  const named = mac ? "safari" : "tidepool studio";
  const steps = [{ text: "Check the site", app: named }, { text: "Draw the icons", app: "Kuvo No Such App" }, "Build the site", ...(mac ? [] : [{ text: "Sketch the screens", app: "Sketchpad" }])];
  const proposed = await tool("propose_goal", { ...PLAN, steps }, { env });
  assert.equal(proposed.isError, false, proposed.text);
  const [goal] = await goals();
  const [found, missing, none, svgOnly] = goal.steps.map(each => each.app);
  assert.deepEqual(found, mac ? { name: "Safari", id: "com.apple.Safari" } : { name: "Tidepool Studio", id: "tidepool" }, "the app by its own name and id here");
  assert.deepEqual(missing, { name: "Kuvo No Such App" }, "no such app here: no id, so no mark");
  assert.equal(none, undefined, "a step that names no app has none");
  if (!mac) assert.deepEqual(svgOnly, { name: "Sketchpad" }, "an icon that's SVG alone: no mark");

  const icon = await route("GET", `kuvo/work/apps/icon?app=${encodeURIComponent(found.id)}`);
  assert.equal(icon.status, 200);
  assert.equal(icon.type, "image/png");
  assert.ok(isPNG(icon.bytes), "a PNG");
  assert.equal(icon.bytes.readUInt32BE(16), mac ? 64 : 128, "at about the size a client draws it (Linux: the theme's smallest that's at least that)");
  assert.equal((await route("GET", "kuvo/work/apps/icon?app=com.example.none")).status, 404);
  assert.equal((await route("GET", "kuvo/work/apps/icon?app=..%2Frun%2Flink")).status, 400);
  // Kept in the box's own folder, and nothing else of it left there.
  assert.deepEqual(fs.readdirSync(path.join(home, "apps")).sort(), [`${found.id}.png`, "found.json"].sort());
});

test("the app a step is done in can be named as it goes, and so can what waits for you", async () => {
  fs.rmSync(path.join(home, "apps"), { recursive: true, force: true });
  const mac = process.platform === "darwin";
  const env = mac ? {} : linuxApps();
  const [named, id] = mac ? ["Safari", "com.apple.Safari"] : ["Tidepool Studio", "tidepool"];
  await startedGoal();
  const said = await tool("goal_progress", { steps: [{ step: 1, state: "doing", app: named }], add: [{ text: "Record the demo", app: named }], waiting: { kind: "you", text: "Sign in to the store", app: named } }, { env });
  assert.equal(said.isError, false, said.text);
  let [goal] = await goals();
  assert.deepEqual(goal.steps[0].app, { name: named, id });
  assert.deepEqual(goal.steps.at(-1).app, { name: named, id }, "a step added with its app");
  assert.deepEqual(goal.waiting.find(each => each.text === "Sign in to the store").app, { name: named, id });
  assert.equal((await tool("goal_progress", { steps: [{ step: 1, app: null }] })).isError, false);
  [goal] = await goals();
  assert.equal(goal.steps[0].app, undefined, "taken away");
  assert.equal((await tool("goal_progress", { steps: [{ step: 1, app: named }] }, { env })).isError, false);
  const cleared = await tool("goal_progress", { steps: [{ step: 1, app: "" }] });
  assert.equal(cleared.isError, false, cleared.text);
  [goal] = await goals();
  assert.equal(goal.steps[0].app, undefined, "an empty name takes it away too, as an empty note does");
  assert.match((await tool("goal_progress", { steps: [{ step: 1, app: "~/bin/tool" }] })).text, /app is the app the step is done in/);
});

test("a goal's card shows the folder Start makes each project in, as making it will, and whether something's there already; none of it holds Start back", async () => {
  const desktop = path.join(home, "Desktop");
  atEnd(() => fs.rmSync(desktop, { recursive: true, force: true }));
  write(path.join(desktop, "money-printer", "README.md"), "Mine.\n");
  fs.mkdirSync(path.join(desktop, "empty"), { recursive: true });
  const projects = ["Storefront", "~/Desktop/money-printer", "~/Desktop/empty", `${desktop}/new-thing`];
  assert.equal((await tool("propose_goal", { ...PLAN, projects })).isError, false);
  let [card] = await goals();
  assert.deepEqual(card.projects, projects, "kept as the plan said, for older clients");
  assert.deepEqual(card.folders, [
    { project: "Storefront", folder: null, shown: null },
    { project: "money-printer", folder: path.join(desktop, "money-printer"), shown: "~/Desktop/money-printer", there: true },
    { project: "empty", folder: path.join(desktop, "empty"), shown: "~/Desktop/empty", there: false },
    { project: "new-thing", folder: path.join(desktop, "new-thing"), shown: "~/Desktop/new-thing", there: false },
  ], "no projects folder picked: none yet for the one named alone; an empty folder isn't something there");

  // Once you pick where new projects go: there, by its name, where something is already.
  write(path.join(developer, "storefront", "index.html"), "<h1>Old</h1>\n");
  write(path.join(home, "box", "work.json"), JSON.stringify({ projectsFolder: developer }));
  [card] = await goals();
  assert.deepEqual(card.folders[0], { project: "Storefront", folder: path.join(developer, "storefront"), shown: "~/Developer/storefront", there: true });

  const started = await route("POST", `kuvo/work/goals/${card.id}`, { action: "start" });
  assert.equal(started.status, 200, "a folder there already is only shown");
  assert.equal(started.body.goal.folders, undefined, "a goal under way shows none");
});

test("you rename a proposed goal's project or move it to a folder of your own from its card, and the card follows; the bot isn't told, and once it runs they can't change", async () => {
  const desktop = path.join(home, "Desktop");
  const settings = path.join(home, "box", "work.json");
  fs.rmSync(settings, { force: true });
  atEnd(() => fs.rmSync(desktop, { recursive: true, force: true }));
  atEnd(() => fs.rmSync(settings, { force: true }));
  assert.equal((await tool("propose_goal", { ...PLAN, projects: ["Storefront"] })).isError, false);
  let [card] = await goals();
  assert.ok(card.checks.some(check => check.id === "projectsFolder"), "a project named alone, with no projects folder picked");
  const told = prompts.length;

  const renamed = await route("POST", `kuvo/work/goals/${card.id}`, { action: "projects", projects: ["Tide Pool"] });
  assert.equal(renamed.status, 200);
  assert.deepEqual(renamed.body.goal.projects, ["Tide Pool"]);
  assert.deepEqual(renamed.body.goal.folders, [{ project: "Tide Pool", folder: null, shown: null }]);
  // Once you pick where new projects go, it's there by its new name.
  write(settings, JSON.stringify({ projectsFolder: developer }));
  [card] = await goals();
  assert.deepEqual(card.folders, [{ project: "Tide Pool", folder: path.join(developer, "tide-pool"), shown: "~/Developer/tide-pool", there: false }]);
  fs.rmSync(settings, { force: true });

  // Moved to a folder of yours that has files: there, and nothing left to pick for it.
  write(path.join(desktop, "tides", "README.md"), "Mine.\n");
  const moved = await route("POST", `kuvo/work/goals/${card.id}`, { action: "projects", projects: ["~/Desktop/tides"] });
  assert.equal(moved.status, 200);
  assert.deepEqual(moved.body.goal.folders, [{ project: "tides", folder: path.join(desktop, "tides"), shown: "~/Desktop/tides", there: true }]);
  assert.equal(moved.body.goal.checks.some(check => check.id === "projectsFolder"), false);
  [card] = await goals();
  assert.deepEqual(card.projects, ["~/Desktop/tides"], "kept");
  assert.equal(prompts.length, told, "the bot hears them as the goal starts");

  for (const projects of [[], ["a", "b", "c", "d", "e", "f"], [""], ["~"], ["/"], "Storefront"]) assert.equal((await route("POST", `kuvo/work/goals/${card.id}`, { action: "projects", projects })).status, 400, JSON.stringify(projects));
  assert.equal((await route("POST", "kuvo/work/goals/goal_none", { action: "projects", projects: ["Storefront"] })).status, 404);

  assert.equal((await route("POST", `kuvo/work/goals/${card.id}`, { action: "start" })).status, 200);
  assert.equal((await route("POST", `kuvo/work/goals/${card.id}`, { action: "projects", projects: ["Storefront"] })).status, 400, "made already");
});

test("a project whose name has no letters or numbers a folder can take, or two that would be the same folder, is refused on the card and in the bot's plan, as make_project would; a name over lines is one line", async () => {
  const settings = path.join(home, "box", "work.json");
  atEnd(() => fs.rmSync(settings, { force: true }));
  // The bot's own plan: told why, so it can propose it again.
  for (const [projects, why] of [[["Магазин"], /Магазин can't be a folder's name: use letters or numbers/], [["🚀"], /🚀 can't be a folder's name/], [["Tide Pool", "tide-pool"], /Tide Pool and tide-pool would be the same folder/]]) {
    const refused = await tool("propose_goal", { ...PLAN, projects });
    assert.equal(refused.isError, true, JSON.stringify(projects));
    assert.match(refused.text, why);
  }
  assert.deepEqual(await goals(), [], "no card for a plan whose projects can't be made");

  assert.equal((await tool("propose_goal", { ...PLAN, projects: ["Storefront"] })).isError, false);
  const [card] = await goals();
  const set = projects => route("POST", `kuvo/work/goals/${card.id}`, { action: "projects", projects });
  for (const [projects, why] of [
    [["日本語"], "日本語 can't be a folder's name: use letters or numbers."],
    [["~/Desktop/日本語"], "日本語 can't be a folder's name: use letters or numbers."],
    [["Tide Pool", "tide pool"], "Tide Pool and tide pool would be the same folder: give them names apart."],
    [["~/Desktop/tides", `${home}/Desktop/tides`], `~/Desktop/tides and ${home}/Desktop/tides would be the same folder: give them names apart.`],
  ]) {
    const refused = await set(projects);
    assert.equal(refused.status, 400, JSON.stringify(projects));
    assert.equal(refused.body.message, why);
  }
  // In the projects folder, a name and the path it would go to are the same folder too.
  write(settings, JSON.stringify({ projectsFolder: developer }));
  assert.equal((await set(["Tide Pool", path.join(developer, "tide-pool")])).status, 400);
  const [still] = await goals();
  assert.deepEqual(still.projects, ["Storefront"], "nothing kept of a list that won't do");

  const lines = await set(["Tide\n  Pool"]);
  assert.equal(lines.status, 200);
  assert.deepEqual(lines.body.goal.projects, ["Tide Pool"], "one line, as the card shows it");
});

test("a plan the bot proposes again keeps the projects you set on its card, and it's told their names; projects it changes itself replace yours, and it's told what yours were", async () => {
  assert.equal((await tool("propose_goal", { ...PLAN, projects: ["Storefront"] })).isError, false);
  let [card] = await goals();
  assert.equal((await route("POST", `kuvo/work/goals/${card.id}`, { action: "projects", projects: ["Tide Pool", "~/Desktop/docs"] })).status, 200);

  // You ask it to change a step: it proposes the plan again, with the projects it had.
  const again = await tool("propose_goal", { ...PLAN, steps: [...PLAN.steps, "Write the launch post"], projects: ["Storefront"] });
  assert.equal(again.isError, false, again.text);
  [card] = await goals();
  assert.equal(card.steps.length, PLAN.steps.length + 1, "the step it changed");
  assert.deepEqual(card.projects, ["Tide Pool", "~/Desktop/docs"], "your projects, as you set them");
  assert.match(again.text, /The user set its projects on the card: "Tide Pool", "~\/Desktop\/docs"\. They're kept/);
  // And again: still yours.
  assert.equal((await tool("propose_goal", { ...PLAN, projects: ["Storefront"] })).isError, false);
  [card] = await goals();
  assert.deepEqual(card.projects, ["Tide Pool", "~/Desktop/docs"]);

  // It changes the projects itself (you asked it in its chat for another): its own replace yours,
  // and it hears what yours were.
  const changed = await tool("propose_goal", { ...PLAN, projects: ["Storefront", "Admin"] });
  assert.equal(changed.isError, false, changed.text);
  [card] = await goals();
  assert.deepEqual(card.projects, ["Storefront", "Admin"]);
  assert.match(changed.text, /The user had set its projects on the card to "Tide Pool", "~\/Desktop\/docs"; the ones you gave replace them/);
  // With nothing of yours left to keep, nothing more is said of them.
  const after = await tool("propose_goal", { ...PLAN, projects: ["Storefront"] });
  [card] = await goals();
  assert.deepEqual(card.projects, ["Storefront"]);
  assert.doesNotMatch(after.text, /projects on the card/);
});

// The apps the box has looked for, as it keeps them.
const foundApps = () => JSON.parse(fs.readFileSync(path.join(home, "apps", "found.json"), "utf8"));

test("a call that won't do has none of its apps looked for, and one call has twenty looked for at most, each name once", async () => {
  fs.rmSync(path.join(home, "apps"), { recursive: true, force: true });
  const steps = count => Array.from({ length: count }, (_, at) => ({ text: `Step ${at + 1}`, app: `Kuvo No Such App ${at + 1}` }));
  const tooMany = await tool("propose_goal", { ...PLAN, steps: steps(1000) });
  assert.match(tooMany.text, /more than 200 steps/);
  assert.equal(fs.existsSync(path.join(home, "apps")), false, "refused before any app was looked for");

  const proposed = await tool("propose_goal", { ...PLAN, steps: [...steps(30), { text: "Again", app: "kuvo no such app 1" }] });
  assert.equal(proposed.isError, false, proposed.text);
  assert.equal(Object.keys(foundApps()).length, 20, "the first twenty names");
  const [card] = await goals();
  assert.deepEqual(card.steps.at(-1).app, { name: "kuvo no such app 1" }, "each kept as it was named");

  await route("POST", `kuvo/work/goals/${card.id}`, { action: "start" });
  const wrong = await tool("goal_progress", { steps: [{ step: 99, app: "Kuvo Another App" }] });
  assert.match(wrong.text, /There's no step 99/);
  assert.equal(Object.hasOwn(foundApps(), "kuvo another app"), false, "a call that's refused looks for nothing");
});

// An app installed on this computer for the test: on a Mac, a bundle in your Applications folder
// (the test's home); on Linux, a desktop entry with its icon, in the test's own data folders.
function installApp(name, id) {
  if (process.platform === "darwin") {
    write(path.join(home, "Applications", `${name}.app`, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleName</key><string>${name}</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>\n`);
    return {};
  }
  const env = linuxApps();
  write(path.join(env.XDG_DATA_DIRS, "applications", `${id}.desktop`), `[Desktop Entry]\nType=Application\nName=${name}\nIcon=${id}\n`);
  write(path.join(env.XDG_DATA_DIRS, "icons", "hicolor", "64x64", "apps", `${id}.png`), png(64));
  return env;
}
const uninstallApp = (name, id) => {
  fs.rmSync(path.join(home, "Applications", `${name}.app`), { recursive: true, force: true });
  fs.rmSync(path.join(home, "xdg", "system", "applications", `${id}.desktop`), { force: true });
};

test("an app found is looked for again a week on, so one you've uninstalled loses its mark and its icon; names not found are forgotten after a month; any name is a name, constructor too", async () => {
  fs.rmSync(path.join(home, "apps"), { recursive: true, force: true });
  atEnd(() => fs.rmSync(path.join(home, "Applications"), { recursive: true, force: true }));
  const id = "com.example.constructor";
  const env = installApp("Constructor", id);
  const propose = async () => {
    assert.equal((await tool("propose_goal", { ...PLAN, steps: [{ text: "Build it", app: "Constructor" }] }, { env })).isError, false);
    return (await goals())[0].steps[0].app;
  };
  assert.deepEqual(await propose(), { name: "Constructor", id }, "found, though every object has a constructor");
  assert.equal((await route("GET", `kuvo/work/apps/icon?app=${id}`)).status, 200);

  // Uninstalled: within the week it's as it was found.
  uninstallApp("Constructor", id);
  assert.deepEqual(await propose(), { name: "Constructor", id });

  // A week on, it's looked for again: gone, with its icon. A miss a month old is forgotten, a newer
  // one kept.
  const now = Date.now();
  const aged = foundApps();
  aged.constructor.at = now - 8 * 86_400_000;
  aged["kuvo old miss"] = { at: now - 40 * 86_400_000 };
  aged["kuvo new miss"] = { at: now - 2 * 86_400_000 };
  fs.writeFileSync(path.join(home, "apps", "found.json"), JSON.stringify(aged));
  assert.deepEqual(await propose(), { name: "Constructor" }, "no mark for an app that isn't here");
  assert.equal((await route("GET", `kuvo/work/apps/icon?app=${id}`)).status, 404);
  assert.deepEqual(fs.readdirSync(path.join(home, "apps")), ["found.json"], "its icon taken away");
  assert.deepEqual(Object.keys(foundApps()).sort(), ["constructor", "kuvo new miss"]);
});

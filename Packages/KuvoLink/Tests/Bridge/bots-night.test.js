// A bot's night (PROTOCOL.md, "Work › A night"): a bot puts its plan for the night to you on one
// card, with what it checked, what it may spend, and a switch for each public step; only you start
// it, and only on a box that may work unattended. Overnight, what's asked and not answered in time
// is said no to and kept for the morning, what only you can fix is told to your phones quietly, and
// the night ends with the morning report. What always comes to you (payments, deletes, messages,
// keys…) never goes without you, whatever the mode or the night. Each call by a process of its own,
// as a machine's tools ask it (`kuvo-link.js box route`); the box's watch over nights in this one.
// The real box script on a folder of the test's own; only the engine is a stand-in.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/bots-night.test.js`.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-bots-night-")));
after(() => fs.rmSync(home, { recursive: true, force: true }));
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
let sessions, prompts, made, asked, replied, interrupted, active;
const tokens = () => ({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });
function resetEngine() {
  sessions = new Map([
    ["ses_pixel", { id: "ses_pixel", title: "Pixel", location: { directory: path.join(pixelFolder, "workspace") }, permissions: [], time: { created: 1, updated: 5 }, cost: 0, tokens: tokens() }],
    ["ses_site", { id: "ses_site", title: "Build the site", location: { directory: driftwood }, permissions: [], time: { created: 2, updated: 6 }, cost: 0, tokens: tokens(), metadata: { kuvo: { startedBy: "ses_pixel", by, depth: 1, wake: ["finished", "asks"] } } }],
  ]);
  prompts = [];
  made = [];
  asked = new Map();
  replied = [];
  interrupted = [];
  active = new Set();
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
    if (one?.[2] === "/form") return reply({ data: [] });
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
after(() => { engine.closeAllConnections(); engine.close(); });
const target = () => [{ port: engine.address().port, password: "p" }];

beforeEach(() => {
  resetEngine();
  for (const each of ["box", "run", "Developer", "bots", "bin", "work"]) fs.rmSync(path.join(home, each), { recursive: true, force: true });
  fs.mkdirSync(driftwood, { recursive: true });
  spawnSync("git", ["init", "-q", driftwood], { env: { ...process.env, HOME: home } });
  fs.mkdirSync(developer, { recursive: true });
  write(path.join(home, "box", "projects.json"), JSON.stringify({ projects: [{ directory: driftwood, name: "Driftwood", folders: [] }] }));
  write(path.join(pixelFolder, "bot.json"), JSON.stringify({ kuvo: 1, id: "bot_pixel00001", name: "Pixel", job: "Builds apps.", look: { color: "graphite", shape: "squircle", face: "bright" }, created: "2026-10-01T09:00:00Z", updated: "2026-10-01T09:00:00Z" }));
  write(path.join(pixelFolder, "session"), "ses_pixel");
  fs.mkdirSync(path.join(pixelFolder, "workspace"), { recursive: true });
  write(path.join(home, "run", "engine.json"), JSON.stringify({ port: engine.address().port, password: "p", version: "0.0.0" }));
  fs.mkdirSync(path.join(home, "bin"), { recursive: true });
  fs.copyFileSync(new URL("../../Sources/KuvoLink/Resources/bot-words.json", import.meta.url), path.join(home, "bin", "bot-words.json"));
});

// The box's answer to one request, as a machine's tool asks it: a process of its own, on a box that
// may work unattended (`unattended`), or one that can't yet.
function route(method, pathname, body, { unattended = true } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, KUVO_HOME: home, HOME: home, TMPDIR: home };
    delete env.KUVO_TEST_SANDBOX_ON;
    if (unattended) env.KUVO_TEST_SANDBOX_ON = "1";
    const child = spawn(process.execPath, [script, "box", "route"], { env, stdio: ["pipe", "pipe", "inherit"] });
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
const tool = async (name, args, { session = "ses_pixel", ...rest } = {}) => (await route("POST", "kuvo/agent-tools", { name, arguments: args, session }, rest)).body;

// The landing-page night, as Pixel puts it.
const PLAN = {
  goal: "Launch a landing page for my coffee subscription, Driftwood. Get a domain, and add Stripe checkout.",
  steps: ["Build the site", "Buy the domain", "Set up DNS", "Deploy", "Add checkout"],
  checks: [
    { text: "Add a Cloudflare API token", detail: "for the domain, DNS and hosting", url: "https://dash.cloudflare.com/profile/api-tokens", button: "Add" },
    { text: "Stripe key works", ok: true },
  ],
  spend: [{ what: "driftwood.coffee", cap: 15 }],
  public: ["Publish the site when it's ready", "Turn on live payments"],
  projects: ["Storefront"],
};
const nights = async () => (await route("GET", "kuvo/work/nights")).body.nights;
async function startedNight(switches = { p1: true }) {
  const proposed = await tool("propose_night", PLAN);
  assert.equal(proposed.isError, false, proposed.text);
  const [night] = await nights();
  const started = await route("POST", `kuvo/work/nights/${night.id}`, { action: "start", public: switches });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  return started.body.night;
}
// Your phones' notifications, as the box's watch tells them.
let told;
const tell = notice => { told.push(notice); return true; };
const look = (wait = 0) => link.lookAtNights(tell, target, { wait });
beforeEach(() => { told = []; });

test("a bot puts its night to you on one card: the plan, what it checked, what it may spend, a switch per public step; a box that can't work unattended says so, and the night can't start there", async () => {
  const said = await tool("propose_night", PLAN, { unattended: false });
  assert.equal(said.isError, false, said.text);
  assert.match(said.text, /can't run a night yet, so the night can't start here/);
  const [night] = (await route("GET", "kuvo/work/nights", null, { unattended: false })).body.nights;
  assert.equal(night.state, "proposed");
  assert.equal(night.name, "Pixel");
  assert.equal(night.session, "ses_pixel");
  assert.equal(night.goal, PLAN.goal);
  assert.deepEqual(night.steps.map(each => [each.text, each.state]), PLAN.steps.map(each => [each, "todo"]));
  assert.equal(night.canStart, false);
  // The box's own checks come first, then the bot's: what only you can do, with its button.
  const unattended = night.checks.find(each => each.id === "unattended");
  assert.deepEqual([unattended.text, unattended.detail, unattended.state, unattended.by], ["This machine can't run a night yet", "Pixel can do the same plan with you here instead", "failed", "box"]);
  assert.doesNotMatch(JSON.stringify(night), /fence|sandbox/i, "the card never says fence or sandbox");
  const token = night.checks.find(each => each.text === "Add a Cloudflare API token");
  assert.deepEqual([token.state, token.by, token.action], ["needs", "bot", { kind: "open", label: "Add", url: "https://dash.cloudflare.com/profile/api-tokens" }]);
  assert.equal(night.checks.find(each => each.text === "Stripe key works").state, "ok");
  assert.deepEqual(night.checks.find(each => each.id === "projectsFolder")?.action, { kind: "projectsFolder", label: "Pick" }, "the plan makes a project and no folder is picked");
  assert.deepEqual(night.spend, [{ what: "driftwood.coffee", cap: 15, currency: "USD" }]);
  assert.deepEqual(night.public, [{ id: "p1", text: "Publish the site when it's ready", on: false }, { id: "p2", text: "Turn on live payments", on: false }], "every public step starts switched off");
  assert.equal(night.wake, false, "a blocker doesn't wake you unless you say so");

  const start = await route("POST", `kuvo/work/nights/${night.id}`, { action: "start", public: { p1: true } }, { unattended: false });
  assert.equal(start.status, 409);
  assert.equal(start.body.needs, "sandbox");
  assert.equal((await route("GET", "kuvo/work/nights", null, { unattended: false })).body.nights[0].state, "proposed", "still only proposed");
  assert.deepEqual(prompts, [], "and the bot isn't told it started");
});

test("only you start the night, with the switches you set; the bot's told what's approved, and asks the box before a public step", async () => {
  // Proposed again, it's the one card.
  await tool("propose_night", { ...PLAN, steps: ["Build the site"] });
  await tool("propose_night", PLAN);
  const listed = await nights();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].steps.length, 5);
  assert.equal(listed[0].canStart, true);
  assert.equal(listed[0].checks.find(each => each.id === "unattended").state, "ok");

  const started = await route("POST", `kuvo/work/nights/${listed[0].id}`, { action: "start", public: { p1: true }, wake: true });
  assert.equal(started.status, 200);
  assert.equal(started.body.night.state, "running");
  assert.deepEqual(started.body.night.public.map(each => each.on), [true, false]);
  assert.equal(started.body.night.wake, true);
  const [told] = prompts;
  assert.equal(told.to, "ses_pixel");
  assert.match(told.text, /^\[Night started\]/);
  assert.match(told.text, /Switched on, so do them when they're ready: "Publish the site when it's ready"\./);
  assert.match(told.text, /Switched off, so prepare them as drafts and leave them for the morning: "Turn on live payments"\./);
  assert.match(told.text, /driftwood\.coffee, up to 15 USD/);

  assert.match((await tool("may_publish", { step: "p1" })).text, /^Yes/);
  assert.match((await tool("may_publish", { step: "Turn on live payments" })).text, /^No: .* switched off/);
  assert.match((await tool("may_publish", { step: "Post on X" })).text, /isn't one of the night's public steps, so it's not approved/);
  // Started already: it can't be started again, nor proposed over.
  assert.equal((await route("POST", `kuvo/work/nights/${listed[0].id}`, { action: "start" })).status, 400);
  assert.equal((await tool("propose_night", PLAN)).isError, true);
  // Only a bot works through a night.
  assert.match((await tool("propose_night", PLAN, { session: "ses_site" })).text, /Only a bot works through a night/);
});

test("Not Tonight tells the bot, and the card goes", async () => {
  await tool("propose_night", PLAN);
  const [night] = await nights();
  const declined = await route("POST", `kuvo/work/nights/${night.id}`, { action: "decline" });
  assert.equal(declined.body.night.state, "declined");
  assert.match(prompts[0].text, /^\[Not tonight\]/);
  assert.equal((await tool("night_progress", { step: 1, state: "doing" })).isError, true, "nothing's running");
});

test("overnight, an ask no one answers in time is said no to, the session works around it, and it waits for you in the morning, told to your phones once and quietly", async () => {
  await startedNight();
  asked.set("ses_site", [{ id: "per_install", action: "shell", resources: ["npm install sharp"] }]);
  await look(60_000);
  assert.deepEqual(replied, [], "it waits a while first");
  await look(0);
  assert.equal(replied.length, 1);
  assert.equal(replied[0].session, "ses_site");
  assert.equal(replied[0].decision, "reject");
  assert.match(replied[0].message, /No one could answer this overnight, so it's no for now\. Work around it/);
  const [night] = await nights();
  const [blocker] = night.blockers;
  assert.equal(blocker.kind, "ask");
  assert.equal(blocker.session, "ses_site");
  assert.match(blocker.text, /^Build the site: /);
  // Kept on the session as answered, for its card.
  assert.equal(sessions.get("ses_site").metadata.kuvo.answers.at(-1).reason, "No one answered overnight");
  assert.equal(told.length, 1);
  assert.deepEqual([told[0].category, told[0].title, told[0].subtitle, told[0].data.session], ["blocked", "Pixel", "Needs you in the morning", "ses_site"]);
  assert.equal(told[0].data.wake, undefined, "an ask doesn't wake you");
  await look(0);
  assert.equal(told.length, 1, "told once");
});

test("the night as it goes: steps marked, what only you can fix kept as a blocker (waking you only if you said so), what's watched, and the morning report told once", async () => {
  const night = await startedNight();
  assert.equal((await tool("night_progress", { steps: [{ step: 1, state: "done" }, { step: 2, state: "doing" }] })).isError, false);
  assert.equal((await tool("night_progress", { step: 9, state: "done" })).isError, true);
  const blocked = await tool("night_progress", { blocker: { kind: "you", text: "Finish Stripe's identity check", detail: "Checkout stays in test mode until then", url: "https://dashboard.stripe.com/account/onboarding" }, watching: ["DNS for driftwood.coffee"] });
  assert.equal(blocked.isError, false, blocked.text);
  await look();
  assert.deepEqual([told[0].category, told[0].body, told[0].data.wake], ["blocked", "Finish Stripe's identity check", undefined]);

  const finished = await tool("finish_night", { report: "One thing first: Stripe still needs your identity check. driftwood.coffee is live.", watching: ["DNS for driftwood.coffee"] });
  assert.equal(finished.isError, false);
  const [done] = await nights();
  assert.equal(done.id, night.id);
  assert.equal(done.state, "done");
  assert.deepEqual(done.steps.slice(0, 2).map(each => each.state), ["done", "doing"]);
  assert.deepEqual(done.watching, ["DNS for driftwood.coffee"]);
  assert.match(done.report, /^One thing first/);
  assert.equal(done.blockers[0].url, "https://dashboard.stripe.com/account/onboarding");
  await look();
  await look();
  const reports = told.filter(each => each.category === "report");
  assert.equal(reports.length, 1, "the report is told once");
  assert.deepEqual([reports[0].title, reports[0].subtitle], ["Pixel's night", "1 thing needs you"]);
});

test("a blocker wakes you only on a night you asked to be woken for", async () => {
  await startedNight({ p1: false });
  await route("POST", "kuvo/work/nights/none", { action: "stop" }).then(answer => assert.equal(answer.status, 404));
  const [night] = await nights();
  // Stopped, and started again with Wake me on.
  await route("POST", `kuvo/work/nights/${night.id}`, { action: "stop" });
  await tool("propose_night", PLAN);
  const [next] = await nights();
  await route("POST", `kuvo/work/nights/${next.id}`, { action: "start", wake: true });
  await tool("night_progress", { blocker: { kind: "you", text: "Sign in to Cloudflare again" } });
  await look();
  assert.equal(told.at(-1).data.wake, "1");
});

test("Stop the Night stops its sessions and the bot's own turn", async () => {
  const night = await startedNight();
  active.add("ses_site");
  active.add("ses_pixel");
  const stopped = await route("POST", `kuvo/work/nights/${night.id}`, { action: "stop" });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.night.state, "stopped");
  assert.ok(interrupted.includes("ses_site"));
  assert.ok(interrupted.includes("ses_pixel"));
  assert.equal((await tool("night_progress", { step: 1, state: "done" })).isError, true);
});

test("during the night, a session the bot starts is told no one's there to answer, a project the plan names is made without asking, and one it doesn't name is said no to after a while", async () => {
  await startedNight();
  write(path.join(home, "box", "work.json"), JSON.stringify({ projectsFolder: developer }));
  const started = await tool("start_session", { task: "Write the landing page copy.", project: "Driftwood" });
  assert.equal(started.isError, false, started.text);
  const sent = prompts.find(each => each.to === made[0].id);
  assert.match(sent.text, /This runs overnight while the user sleeps/);

  const planned = await tool("make_project", { name: "Storefront" });
  assert.equal(planned.isError, false, planned.text);
  assert.ok(fs.existsSync(path.join(developer, "storefront", ".git")), "made at once: you approved it with the night");

  const unplanned = tool("make_project", { name: "Blog" }, {});
  let ask;
  while (!ask) ask = (await route("GET", "kuvo/work/asks")).body.asks[0];
  await look(0);
  const said = await unplanned;
  assert.equal(said.isError, true);
  assert.match(said.text, /No one could answer making Blog overnight/);
  const [night] = await nights();
  assert.ok(night.blockers.some(each => each.kind === "outside" && /Blog/.test(each.text)));
});

test("what always comes to you is never the bot's to allow, whatever it's asked as, and a bot's sessions ask for it even on Approve All", async () => {
  const cases = [
    [{ action: "shell", resources: ["rm notes.md"] }, /a permanent delete/],
    [{ action: "shell", resources: ["git config user.email pixel@example.com"] }, /a change to git's settings/],
    [{ action: "shell", resources: ["gh pr create --fill"] }, /a message to someone/],
    [{ action: "shell", resources: ["curl -X POST https://api.stripe.com/v1/charges -d amount=500"] }, /a payment/],
    [{ action: "shell", resources: ["chmod 777 site"] }, /a change to who may do what/],
    [{ action: "edit", resources: [path.join(driftwood, ".env")] }, /your passwords, keys or sign-ins/],
    [{ action: "gmail_send_email", resources: ["*"], tool: "gmail_send_email", input: { to: "ada@example.com" } }, /a message to someone/],
  ];
  for (const [ask, words] of cases) {
    asked.set("ses_site", [{ id: "per_one", ...ask }]);
    const said = await tool("answer_ask", { session: "ses_site", ask: "per_one", decision: "allow", reason: "Part of the plan." });
    assert.equal(said.isError, true, `${JSON.stringify(ask)}: ${said.text}`);
    assert.match(said.text, words, said.text);
    assert.match(said.text, /always comes to the user/);
  }
  assert.deepEqual(replied, [], "none was answered");

  // A session Pixel starts on its own Approve All asks before any of them; your Don't Allow stays.
  sessions.get("ses_pixel").permissions = [{ action: "shell", resource: "*", effect: "allow" }, { action: "shell", resource: "rm -rf *", effect: "deny" }];
  const started = await tool("start_session", { task: "Tidy the repo.", project: "Driftwood" });
  assert.equal(started.isError, false, started.text);
  const rules = made[0].permissions;
  const last = (resource) => rules.findLast(rule => rule.action === "shell" && rule.resource === resource)?.effect;
  assert.equal(last("rm *"), "ask");
  assert.equal(last("git config*"), "ask");
  assert.equal(last("rm -rf *"), "deny", "what you don't allow stays not allowed");
  assert.ok(rules.findLastIndex(rule => rule.resource === "rm -rf *" && rule.effect === "deny") > rules.findLastIndex(rule => rule.resource === "rm *"), "after the asks, so it wins");
});

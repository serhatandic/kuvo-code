// A conversation on Autopilot (PROTOCOL.md, "Autopilot"): turned on and off on its box
// (`kuvo/sessions/<id>/autopilot`), its agent told how to work there; a question it asks with a
// choice marked "(Recommended)" goes ahead on that choice at once, kept as a call it made, which you
// can change; one without a mark, and any in an Interactive conversation, waits for you as ever.
// The real box script, its routes each asked by a process of their own as a machine's tools ask
// them; only the engine is a stand-in.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/autopilot.test.js`.
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

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-autopilot-")));
process.env.KUVO_HOME = home;
removeAtEnd(home);
const script = fileURLToPath(new URL("../../Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url));
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");
const project = path.join(home, "work", "cafe");
fs.mkdirSync(project, { recursive: true });

const QUESTION = (id, session, labels) => ({
  id, sessionID: session, title: "House blend", metadata: { kind: "question" },
  fields: [{ key: "roast", type: "string", title: "Which roast for the house blend?", required: true,
             options: labels.map((label, index) => ({ value: `r${index}`, label, ...(label.includes("(Recommended)") ? { description: "Best reviewed, and it suits the pastries" } : {}) })) }],
});
const ROASTS = ["Light and fruity", "Warm and roasty (Recommended)", "Dark and smoky"];

// The engine: its sessions as PATCH changes them, the questions waiting and answered, the
// instructions kept (and those it refuses) and the messages sent.
let sessions;
let waiting;
let answered;
let entries;
let refusesEntries;
let prompts;
let refusesPrompts;
const engine = http.createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    const reply = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    const url = new URL(request.url, "http://x");
    const given = body ? JSON.parse(body) : undefined;
    if (url.pathname === "/api/session" && request.method === "GET") {
      const parent = url.searchParams.get("parentID");
      return reply({ data: [...sessions.values()].filter(each => (parent && parent !== "null" ? each.parentID === parent : !each.parentID)) });
    }
    if (url.pathname === "/api/session/active") return reply({ data: {} });
    const entry = url.pathname.match(/^\/api\/experimental\/session\/([^/]+)\/instructions\/entries\/([^/]+)$/);
    if (entry) {
      const key = `${decodeURIComponent(entry[1])} ${decodeURIComponent(entry[2])}`;
      if (refusesEntries) return reply({ message: "Not now." }, 500);
      if (request.method === "PUT") entries.set(key, given.value);
      if (request.method === "DELETE") entries.delete(key);
      return reply({ data: true });
    }
    const form = url.pathname.match(/^\/api\/session\/([^/]+)\/form\/([^/]+)\/reply$/);
    if (form && request.method === "POST") {
      const asker = decodeURIComponent(form[1]);
      answered.push({ session: asker, form: decodeURIComponent(form[2]), answer: given.answer });
      waiting.set(asker, (waiting.get(asker) ?? []).filter(each => each.id !== decodeURIComponent(form[2])));
      return reply({ data: true });
    }
    const forms = url.pathname.match(/^\/api\/session\/([^/]+)\/form$/);
    if (forms) return reply({ data: waiting.get(decodeURIComponent(forms[1])) ?? [] });
    const prompt = url.pathname.match(/^\/api\/session\/([^/]+)\/prompt$/);
    if (prompt && request.method === "POST" && refusesPrompts) return reply({ message: "Not now." }, 500);
    if (prompt && request.method === "POST") { prompts.push({ to: decodeURIComponent(prompt[1]), ...given }); return reply({ data: true }); }
    if (/\/(permission|form)$/.test(url.pathname)) return reply({ data: [] });
    const one = url.pathname.match(/^\/api\/session\/([^/]+)$/);
    const id = one && decodeURIComponent(one[1]);
    if (one && request.method === "GET") return sessions.has(id) ? reply({ data: sessions.get(id) }) : reply({ message: "No such session." }, 404);
    if (one && request.method === "PATCH" && sessions.has(id)) {
      sessions.set(id, { ...sessions.get(id), ...given });
      return reply({ data: sessions.get(id) });
    }
    reply({ message: "Not here." }, 404);
  });
});
await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
atEnd(() => { engine.closeAllConnections(); engine.close(); });
const source = { port: engine.address().port, password: "p" };
fs.mkdirSync(path.join(home, "run"), { recursive: true });
fs.writeFileSync(path.join(home, "run", "engine.json"), JSON.stringify({ ...source, version: "0.0.0" }));

const session = (id, more = {}) => ({ id, title: id, location: { directory: project }, time: { created: 1, updated: 1 }, ...more });

beforeEach(() => {
  sessions = new Map([
    ["ses_mine", session("ses_mine", { metadata: { kuvo: { approval: "auto", applied: "auto" } } })],
    ["ses_away", session("ses_away", { metadata: { kuvo: { approval: "auto", applied: "auto", autopilot: true } } })],
    ["ses_helper", session("ses_helper", { parentID: "ses_away" })],
    // A session ses_lead started, which wakes it when it asks.
    ["ses_lead", session("ses_lead")],
    ["ses_menu", session("ses_menu", { metadata: { kuvo: { startedBy: "ses_lead", wake: ["asks"], autopilot: true } } })],
    ["ses_copy", session("ses_copy", { metadata: { kuvo: { startedBy: "ses_lead", wake: ["asks"] } } })],
  ]);
  waiting = new Map();
  answered = [];
  entries = new Map();
  refusesEntries = false;
  prompts = [];
  refusesPrompts = false;
  fs.rmSync(path.join(home, "run", "work"), { recursive: true, force: true });
});

function route(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, KUVO_HOME: home, HOME: home, TMPDIR: home };
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

// The watcher, as the box starts it (what it catches up on done), its clock the test's: what it
// would tell later, told when the test says.
async function watcher() {
  const later = [];
  const stop = new AbortController();
  atEnd(() => stop.abort());
  const watch = link.workWatcher(source, () => [source], { schedule: run => { later.push(run); }, signal: stop.signal });
  await watch.caughtUp;
  return { watch, tellAll: async () => { for (const run of later.splice(0)) await run(); } };
}

test("a conversation is Interactive until it's turned on; on, it's kept with it and its agent is told how to work; off again, it's told no longer", async () => {
  assert.deepEqual((await route("GET", "kuvo/sessions/ses_mine/autopilot")).body, { autopilot: false, decided: [] });
  const on = await route("PUT", "kuvo/sessions/ses_mine/autopilot", { autopilot: true });
  assert.equal(on.status, 200);
  assert.equal(on.body.autopilot, true);
  assert.deepEqual(sessions.get("ses_mine").metadata.kuvo, { approval: "auto", applied: "auto", autopilot: true }, "kept beside its approval, which stays as it was");
  assert.match(entries.get("ses_mine kuvo.autopilot"), /Autopilot/);
  assert.match(entries.get("ses_mine kuvo.autopilot"), /\(Recommended\)/, "told to mark the choice it recommends");
  assert.equal((await route("GET", "kuvo/sessions/ses_mine/autopilot")).body.autopilot, true);
  const off = await route("PUT", "kuvo/sessions/ses_mine/autopilot", { autopilot: false });
  assert.equal(off.body.autopilot, false);
  assert.equal(sessions.get("ses_mine").metadata.kuvo.autopilot === true, false);
  assert.equal(sessions.get("ses_mine").metadata.kuvo.approval, "auto");
  assert.equal(entries.has("ses_mine kuvo.autopilot"), false);
  assert.equal((await route("PUT", "kuvo/sessions/ses_mine/autopilot", { autopilot: "yes" })).status, 400);
  assert.equal((await route("GET", "kuvo/sessions/ses_mine/autopilot")).body.autopilot, false);
  assert.equal((await route("GET", "kuvo/sessions/ses_gone/autopilot")).status, 404);
});

test("on Autopilot, a question that marks the choice it recommends goes ahead on it at once, a subagent's too, kept as a call it made", async () => {
  const { watch } = await watcher();
  // (Asked by a tool call, as the engine's questions are: a client shows the call at that step.)
  await watch({ type: "form.created", data: { form: { ...QUESTION("frm_1", "ses_away", ROASTS), metadata: { kind: "question", tool: { messageID: "msg_1", id: "call_roast" } } } } });
  await watch({ type: "form.created", data: { form: QUESTION("frm_2", "ses_helper", ["Pickup only (Recommended)", "Delivery too"]) } });
  assert.deepEqual(answered, [
    { session: "ses_away", form: "frm_1", answer: { roast: "r1" } },
    { session: "ses_helper", form: "frm_2", answer: { roast: "r0" } },
  ]);
  const { decided } = (await route("GET", "kuvo/sessions/ses_away/autopilot")).body;
  assert.equal(decided.length, 2);
  assert.deepEqual({ ...decided[0], at: 0 }, { id: "frm_1", text: "Which roast for the house blend?", choice: "Warm and roasty", why: "Best reviewed, and it suits the pastries", options: ["Light and fruity", "Warm and roasty", "Dark and smoky"], call: "call_roast", at: 0 });
  assert.equal(decided[1].call, undefined, "one no tool call asked has none");
  assert.equal(decided[1].session, "ses_helper", "a subagent's says which asked");
});

test("a question without a recommendation, and any in an Interactive conversation, waits for you, and its starter hears of it as ever", async () => {
  const { watch, tellAll } = await watcher();
  await watch({ type: "form.created", data: { form: QUESTION("frm_3", "ses_away", ["Light and fruity", "Warm and roasty"]) } });
  await watch({ type: "form.created", data: { form: QUESTION("frm_4", "ses_mine", ROASTS) } });
  await watch({ type: "form.created", data: { form: QUESTION("frm_5", "ses_copy", ROASTS) } });
  assert.deepEqual(answered, []);
  await tellAll();
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].to, "ses_lead");
  assert.match(prompts[0].text, /\[Session asks\] "ses_copy"/);
});

test("what only you can do goes to you: its agent is told to ask it with no mark, and a form asking for a secret waits, whatever it marks", async () => {
  await route("PUT", "kuvo/sessions/ses_mine/autopilot", { autopilot: true });
  const told = entries.get("ses_mine kuvo.autopilot");
  for (const word of [/paying/, /signing in/, /making an account/, /handing over a key/, /destructive/]) assert.match(told, word);
  assert.match(told, /no choice marked: that one waits for them, and they're notified/);
  const { watch } = await watcher();
  const key = QUESTION("frm_key", "ses_away", ["Use this key (Recommended)", "Skip"]);
  key.fields[0].format = "password";
  const optional = QUESTION("frm_keyed", "ses_away", ROASTS);
  optional.fields.push({ key: "token", type: "string", title: "Your token", required: false, format: "password" });
  const paying = QUESTION("frm_pay", "ses_away", ["I'll pay", "Skip"]);
  for (const form of [key, optional, paying]) await watch({ type: "form.created", data: { form } });
  assert.deepEqual(answered, []);
  assert.deepEqual((await route("GET", "kuvo/sessions/ses_away/autopilot")).body.decided, []);
});

test("an MCP server's form never goes ahead, whatever it marks, here or from a coding agent's conversation", async () => {
  const { watch } = await watcher();
  const server = { ...QUESTION("frm_server", "ses_away", ROASTS), metadata: { kind: "mcp-elicitation", server: "probe" } };
  await watch({ type: "form.created", data: { form: server } });
  assert.deepEqual(answered, []);
  assert.deepEqual((await route("GET", "kuvo/sessions/ses_away/autopilot")).body.decided, []);
});

test("one a session on Autopilot went ahead on isn't put to its starter", async () => {
  const { watch, tellAll } = await watcher();
  await watch({ type: "form.created", data: { form: QUESTION("frm_6", "ses_menu", ROASTS) } });
  await tellAll();
  assert.deepEqual(answered.map(each => each.form), ["frm_6"]);
  assert.deepEqual(prompts, [], "nothing waits, so its starter has nothing to answer");
});

test("your choice on a call: the same confirms it quietly; another tells the conversation to go that way", async () => {
  const { watch } = await watcher();
  await watch({ type: "form.created", data: { form: QUESTION("frm_1", "ses_away", ROASTS) } });
  const same = await route("POST", "kuvo/sessions/ses_away/autopilot", { decided: "frm_1", choice: "Warm and roasty" });
  assert.equal(same.status, 200);
  assert.equal(same.body.decided[0].yours.choice, "Warm and roasty");
  assert.deepEqual(prompts, []);
  const other = await route("POST", "kuvo/sessions/ses_away/autopilot", { decided: "frm_1", choice: "Light and fruity" });
  assert.equal(other.status, 200);
  assert.equal(other.body.decided[0].yours.choice, "Light and fruity");
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].to, "ses_away");
  assert.match(prompts[0].text, /^\[Decision changed\] For "Which roast for the house blend\?" the user (now )?picked Light and fruity, not Warm and roasty/);
  assert.deepEqual(prompts[0].metadata, { kuvo: { note: { from: "Autopilot", line: "You picked Light and fruity" } } });
  // Back to its own choice: the conversation, going your way now, is told to go back.
  await route("POST", "kuvo/sessions/ses_away/autopilot", { decided: "frm_1", choice: "Warm and roasty" });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1].text, /the user now picked Warm and roasty, not Light and fruity/);
  // The same again: nothing new to tell.
  await route("POST", "kuvo/sessions/ses_away/autopilot", { decided: "frm_1", choice: "Warm and roasty" });
  assert.equal(prompts.length, 2);
  assert.equal((await route("POST", "kuvo/sessions/ses_away/autopilot", { decided: "frm_9", choice: "Dark" })).status, 404);
  assert.equal((await route("POST", "kuvo/sessions/ses_away/autopilot", { decided: "frm_1" })).status, 400);
});

test("a change the engine didn't take isn't kept: it says so, and making it again reaches the agent", async () => {
  const { watch } = await watcher();
  await watch({ type: "form.created", data: { form: QUESTION("frm_1", "ses_away", ROASTS) } });
  refusesPrompts = true;
  const failed = await route("POST", "kuvo/sessions/ses_away/autopilot", { decided: "frm_1", choice: "Light and fruity" });
  assert.equal(failed.status, 502);
  assert.equal((await route("GET", "kuvo/sessions/ses_away/autopilot")).body.decided[0].yours, undefined, "it doesn't read as your choice");
  refusesPrompts = false;
  const again = await route("POST", "kuvo/sessions/ses_away/autopilot", { decided: "frm_1", choice: "Light and fruity" });
  assert.equal(again.status, 200);
  assert.equal(prompts.length, 1, "told now");
  assert.match(prompts[0].text, /picked Light and fruity, not Warm and roasty/);
  assert.equal(again.body.decided[0].yours.choice, "Light and fruity");
});

test("a change to a goal's call the bot couldn't hear isn't kept either", async () => {
  goalIn("ses_mine", { decided: [{ id: "dec_host", text: "Which hosting?", choice: "Cloudflare", options: ["Cloudflare", "Vercel"], at: 1 }] });
  refusesPrompts = true;
  assert.equal((await route("POST", "kuvo/work/goals/goal_cafe", { action: "decided", decided: "dec_host", choice: "Vercel" })).status, 502);
  assert.equal(goalDecided()[0].yours, undefined);
  refusesPrompts = false;
  const again = await route("POST", "kuvo/work/goals/goal_cafe", { action: "decided", decided: "dec_host", choice: "Vercel" });
  assert.equal(again.status, 200);
  assert.equal(again.body.goal.decided[0].yours.choice, "Vercel");
  assert.equal(prompts.length, 1);
});

test("the engine doesn't take it: the conversation stays as it was, and says so", async () => {
  refusesEntries = true;
  assert.equal((await route("PUT", "kuvo/sessions/ses_mine/autopilot", { autopilot: true })).status, 502);
  assert.deepEqual(sessions.get("ses_mine").metadata.kuvo, { approval: "auto", applied: "auto" }, "not marked: its questions don't go ahead while its agent was never told");
  assert.equal((await route("GET", "kuvo/sessions/ses_mine/autopilot")).body.autopilot, false);
  assert.equal((await route("PUT", "kuvo/sessions/ses_away/autopilot", { autopilot: false })).status, 502, "nor taken off while its agent is still told it's on");
});

test("turned on with a question waiting, it goes ahead on its recommendation then; one without waits", async () => {
  waiting.set("ses_mine", [QUESTION("frm_7", "ses_mine", ROASTS), QUESTION("frm_8", "ses_mine", ["Pickup", "Delivery"])]);
  const on = await route("PUT", "kuvo/sessions/ses_mine/autopilot", { autopilot: true });
  assert.deepEqual(answered, [{ session: "ses_mine", form: "frm_7", answer: { roast: "r1" } }]);
  assert.deepEqual(on.body.decided.map(each => each.choice), ["Warm and roasty"]);
  assert.deepEqual(waiting.get("ses_mine").map(each => each.id), ["frm_8"]);
});

test("asked while the box wasn't listening: it goes ahead as the box starts again, a subagent's too", async () => {
  waiting.set("ses_away", [QUESTION("frm_9", "ses_away", ROASTS)]);
  waiting.set("ses_helper", [QUESTION("frm_10", "ses_helper", ["Pickup only (Recommended)", "Delivery too"])]);
  waiting.set("ses_mine", [QUESTION("frm_11", "ses_mine", ROASTS)]);
  await watcher();
  assert.deepEqual(answered.map(each => each.form).sort(), ["frm_10", "frm_9"], "an Interactive conversation's still waits");
  assert.equal((await route("GET", "kuvo/sessions/ses_away/autopilot")).body.decided.length, 2);
});

test("your phone isn't told of a question that goes ahead on Autopilot; of one that waits, as ever", async () => {
  const get = async at => {
    const id = decodeURIComponent(at.match(/^api\/session\/([^/?]+)$/)?.[1] ?? "");
    return { data: sessions.get(id) };
  };
  assert.equal(await link.noticeFor({ type: "form.created", data: { form: QUESTION("frm_1", "ses_away", ROASTS) } }, get), null);
  assert.equal(await link.noticeFor({ type: "form.created", data: { form: QUESTION("frm_2", "ses_helper", ROASTS) } }, get), null);
  assert.notEqual(await link.noticeFor({ type: "form.created", data: { form: QUESTION("frm_3", "ses_away", ["Light", "Dark"]) } }, get), null);
  assert.notEqual(await link.noticeFor({ type: "form.created", data: { form: QUESTION("frm_4", "ses_mine", ROASTS) } }, get), null);
});

// A bot's goal running in the conversation (its bot's own), as the box keeps it.
function goalIn(session, more = {}) {
  const bot = path.join(home, "bots", "bot_ada");
  fs.mkdirSync(bot, { recursive: true });
  fs.writeFileSync(path.join(bot, "bot.json"), JSON.stringify({ kuvo: 1, id: "bot_ada", name: "Ada", job: "Builds sites.", look: { color: "mint", shape: "round", face: "calm" }, created: "2026-10-01T09:00:00Z", updated: "2026-10-01T09:00:00Z" }));
  fs.writeFileSync(path.join(bot, "session"), session);
  fs.mkdirSync(path.join(home, "run", "work"), { recursive: true });
  fs.writeFileSync(path.join(home, "run", "work", "goals.json"), JSON.stringify({ goals: [{ id: "goal_cafe", bot: "bot_ada", session, name: "Ada", goal: "A cafe site", title: "Cafe site", state: "running", steps: [], waiting: [], paused: [], checks: [], spend: [], waited: 0, ...more }] }));
}
const goalDecided = () => JSON.parse(fs.readFileSync(path.join(home, "run", "work", "goals.json"), "utf8")).goals[0].decided ?? [];

test("a call made in a goal's conversation shows on the goal too; while you have the goal paused, it waits for you", async () => {
  goalIn("ses_away");
  const { watch } = await watcher();
  await watch({ type: "form.created", data: { form: QUESTION("frm_1", "ses_away", ROASTS) } });
  assert.deepEqual(goalDecided().map(each => [each.id, each.choice]), [["ask:ses_away:frm_1", "Warm and roasty"]]);
  goalIn("ses_away", { heldByYou: 1 });
  await watch({ type: "form.created", data: { form: QUESTION("frm_2", "ses_away", ROASTS) } });
  assert.deepEqual(answered.map(each => each.form), ["frm_1"]);
});

test("a call a question went ahead on is one call: changed on the goal, its conversation's agent hears and both show it; changed at its step, the goal shows it", async () => {
  goalIn("ses_away");
  const { watch } = await watcher();
  await watch({ type: "form.created", data: { form: QUESTION("frm_1", "ses_away", ROASTS) } });
  await watch({ type: "form.created", data: { form: QUESTION("frm_2", "ses_away", ROASTS) } });
  const onGoal = await route("POST", "kuvo/work/goals/goal_cafe", { action: "decided", decided: "ask:ses_away:frm_1", choice: "Dark and smoky" });
  assert.equal(onGoal.status, 200, JSON.stringify(onGoal.body));
  assert.equal(onGoal.body.goal.decided[0].yours.choice, "Dark and smoky");
  assert.deepEqual(prompts.map(each => each.to), ["ses_away"], "told once, in the conversation that asked");
  let { decided } = (await route("GET", "kuvo/sessions/ses_away/autopilot")).body;
  assert.equal(decided[0].yours.choice, "Dark and smoky");
  await route("POST", "kuvo/sessions/ses_away/autopilot", { decided: "frm_2", choice: "Light and fruity" });
  assert.equal(goalDecided()[1].yours.choice, "Light and fruity");
  assert.equal(prompts.length, 2);
});

test("a goal and its bot's conversation are one setting: switched on either, the other follows", async () => {
  goalIn("ses_mine");
  const goalMode = () => JSON.parse(fs.readFileSync(path.join(home, "run", "work", "goals.json"), "utf8")).goals[0].mode ?? "interactive";
  assert.equal((await route("PUT", "kuvo/sessions/ses_mine/autopilot", { autopilot: true })).status, 200);
  assert.equal(goalMode(), "autopilot");
  assert.match(prompts.at(-1).text, /^\[Goal changed\] The user switched the goal to Autopilot/);
  const back = await route("POST", "kuvo/work/goals/goal_cafe", { action: "change", mode: "interactive" });
  assert.equal(back.status, 200);
  assert.equal(back.body.goal.mode, "interactive");
  assert.equal((await route("GET", "kuvo/sessions/ses_mine/autopilot")).body.autopilot, false);
  assert.equal(entries.has("ses_mine kuvo.autopilot"), false);
});

test("a goal started without saying how it runs (from an app before Autopilot) runs as its conversation does, which stays on", async () => {
  goalIn("ses_away", { state: "proposed", proposed: Date.now(), projects: [] });
  const started = await route("POST", "kuvo/work/goals/goal_cafe", { action: "start", wake: false });
  assert.equal(started.status, 200);
  assert.equal(started.body.goal.mode, "autopilot");
  assert.equal((await route("GET", "kuvo/sessions/ses_away/autopilot")).body.autopilot, true);
});

// A session at the goal running in ses_mine.
const atWork = (id, autopilot) => session(id, { time: { created: Date.now(), updated: 1 }, metadata: { kuvo: { by: { bot: "bot_ada", name: "Ada" }, startedBy: "ses_mine", ...(autopilot ? { autopilot: true } : {}) } } });

test("switching a goal reaches its running sessions: off, their questions wait and their agents are told no longer; on, they go ahead again; one the engine turned away follows on the box's next look", async () => {
  goalIn("ses_mine", { mode: "autopilot", started: Date.now() - 1000 });
  sessions.set("ses_work", atWork("ses_work", true));
  entries.set("ses_work kuvo.autopilot", "On Autopilot");
  const off = await route("POST", "kuvo/work/goals/goal_cafe", { action: "change", mode: "interactive" });
  assert.equal(off.status, 200);
  assert.equal(off.body.goal.following, undefined, "nothing of how it follows goes to a client");
  assert.equal(sessions.get("ses_work").metadata.kuvo.autopilot, false);
  assert.equal(entries.has("ses_work kuvo.autopilot"), false);
  const { watch } = await watcher();
  await watch({ type: "form.created", data: { form: QUESTION("frm_1", "ses_work", ROASTS) } });
  assert.deepEqual(answered, [], "it waits for you");

  refusesEntries = true;
  assert.equal((await route("POST", "kuvo/work/goals/goal_cafe", { action: "change", mode: "autopilot" })).status, 200);
  assert.equal(sessions.get("ses_work").metadata.kuvo.autopilot === true, false, "turned away: as it was");
  refusesEntries = false;
  await link.lookAtGoals(() => true, () => [source], { now: Date.now() });
  assert.equal(sessions.get("ses_work").metadata.kuvo.autopilot, true);
  assert.match(entries.get("ses_work kuvo.autopilot"), /Autopilot/);
});

test("the box's look at a goal goes by each session's own switch, and what it goes ahead on shows at its step as one heard as it's asked does", async () => {
  goalIn("ses_mine", { mode: "autopilot", started: Date.now() - 1000 });
  sessions.set("ses_on", atWork("ses_on", true));
  sessions.set("ses_off", atWork("ses_off", false));
  const asked = (id, session) => ({ ...QUESTION(id, session, ROASTS), metadata: { kind: "question", tool: { id: `call_${id}` } } });
  waiting.set("ses_on", [asked("frm_on", "ses_on")]);
  waiting.set("ses_off", [asked("frm_off", "ses_off")]);
  const now = Date.now();
  await link.lookAtGoals(() => true, () => [source], { now });
  await link.lookAtGoals(() => true, () => [source], { now: now + 5 * 60_000 });
  assert.deepEqual(answered.map(each => each.form), ["frm_on"], "you turned the other off yourself");
  assert.deepEqual((await route("GET", "kuvo/sessions/ses_on/autopilot")).body.decided.map(each => [each.choice, each.call]), [["Warm and roasty", "call_frm_on"]]);
  assert.deepEqual(goalDecided().map(each => each.id), ["ask:ses_on:frm_on"]);
});

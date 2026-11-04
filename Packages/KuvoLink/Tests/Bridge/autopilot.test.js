// A conversation on Autopilot (PROTOCOL.md, "Autopilot"): turned on and off on its box
// (`kuvo/sessions/<id>/autopilot`), its agent told how to work there; a question it asks with a
// choice marked "(Recommended)" goes ahead on that choice at once, kept as a call it made, which you
// can change; one without a mark, and any in an Interactive conversation, waits for you as ever.
// The real box script, its routes each asked by a process of their own as a machine's tools ask
// them; only the engine is a stand-in.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/autopilot.test.js`.
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
  await watch({ type: "form.created", data: { form: QUESTION("frm_1", "ses_away", ROASTS) } });
  await watch({ type: "form.created", data: { form: QUESTION("frm_2", "ses_helper", ["Pickup only (Recommended)", "Delivery too"]) } });
  assert.deepEqual(answered, [
    { session: "ses_away", form: "frm_1", answer: { roast: "r1" } },
    { session: "ses_helper", form: "frm_2", answer: { roast: "r0" } },
  ]);
  const { decided } = (await route("GET", "kuvo/sessions/ses_away/autopilot")).body;
  assert.equal(decided.length, 2);
  assert.deepEqual({ ...decided[0], at: 0 }, { id: "frm_1", text: "Which roast for the house blend?", choice: "Warm and roasty", why: "Best reviewed, and it suits the pastries", options: ["Light and fruity", "Warm and roasty", "Dark and smoky"], at: 0 });
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

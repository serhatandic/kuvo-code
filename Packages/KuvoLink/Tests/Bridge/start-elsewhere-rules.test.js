// Work on another of your computers (PROTOCOL.md, "Peers", `call`, start_session; design section 9,
// piece 3): a lead on one of your computers starts a session on another as if it lived there. What
// the box it's started on takes, and from whom: only while you let your other computers start work
// there; in the lead's mode, with no more approval than the lead has where it lives and no more than
// this computer gives (Full Access only where you confirmed it here), and the lead's Don't Allows
// held here too, however often its rules are made again; once however often its call comes, and
// finished from where it got to should the box go down; a line across three computers listed and
// stopped from its top; a bot's Stop All reaching it. And the caller's side: who's calling goes as
// its own computer knows it, never as the agent says, and a computer that isn't answering is said so
// at once.
//
// It runs in one process: this box is the real link, and the other boxes are scripted. The engine
// is a stand-in.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/start-elsewhere-rules.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { atEnd, removeAtEnd } from "./at-end.js";

const script = fileURLToPath(new URL("../../Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url));
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-start-rules-")));
process.env.KUVO_HOME = home;
process.env.KUVO_BOTS = path.join(home, "bots");
removeAtEnd(home);
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");

const DAY = 86_400_000;
const run = path.join(home, "run");
const k = key => key.toString("base64url");
const box = (kind, id) => {
  const key = link.newKey();
  const address = k(link.addressOf(crypto.randomBytes(32)));
  return { key, pub: k(link.publicOf(key)), address, peer: { key: k(link.publicOf(key)), address, name: id ?? kind, kind, ...(id ? { id } : {}) } };
};
const here = box("machine", "devbox"), mac = box("mac"), mini = box("machine", "mini"), third = box("machine", "third");
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
};
const read = file => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };

// An engine with these sessions, as the engine keeps them: what's made, sent, interrupted.
async function engine(sessions) {
  const seen = { made: [], prompts: [], interrupted: [], patched: [] };
  const all = new Map(Object.entries(sessions).map(([id, each]) => [id, { id, time: { created: 1, updated: 1 }, directory: "/work", ...each }]));
  const messages = new Map();
  const active = new Set();
  let next = 0;
  const server = http.createServer((request, response) => {
    let text = "";
    request.on("data", chunk => { text += chunk; });
    request.on("end", () => {
      const given = text ? JSON.parse(text) : {};
      const reply = (value, status = 200) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(status < 400 ? { data: value } : { message: value }));
      const url = new URL(request.url, "http://x");
      if (url.pathname === "/api/session" && request.method === "GET") return reply([...all.values()].filter(each => !each.parentID).sort((a, b) => b.time.created - a.time.created));
      if (url.pathname === "/api/session" && request.method === "POST") {
        const id = `ses_made${++next}`;
        const session = { id, time: { created: Date.now(), updated: Date.now() }, directory: given.location?.directory, title: given.title ?? "New Session", ...(given.agent ? { agent: given.agent } : {}), ...(given.model ? { model: given.model } : {}), permissions: given.permissions, metadata: given.metadata };
        all.set(id, session);
        seen.made.push(session);
        return reply(session);
      }
      if (url.pathname === "/api/session/active") return reply(Object.fromEntries([...active].map(id => [id, {}])));
      // Worktrees, as the engine makes them with git, for the folder a request is about.
      const raw = (value, status = 200) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      const about = decodeURIComponent(request.headers["x-opencode-directory"] ?? "");
      if (url.pathname === "/api/location") return raw({ directory: about, project: { id: `prj:${about}` } });
      if (url.pathname === "/api/worktree" && request.method === "POST") {
        const folder = path.join(home, "worktrees", `tree-${++next}`);
        execFileSync("git", ["worktree", "add", "-q", "--detach", folder], { cwd: given.projectID.slice(4) });
        return raw({ directory: folder });
      }
      if (url.pathname === "/api/worktree" && request.method === "DELETE") {
        try { execFileSync("git", ["worktree", "remove", "--force", given.directory], { cwd: given.projectID.slice(4) }); } catch { return raw({ message: "git refused" }, 400); }
        return raw({});
      }
      if (url.pathname === "/api/provider") return reply([{ id: "p" }]);
      if (url.pathname === "/api/model") return reply([{ id: "m1", providerID: "p", name: "Model One" }]);
      if (url.pathname.startsWith("/api/experimental/")) return reply({});
      const one = url.pathname.match(/^\/api\/session\/([^/]+)(\/.*)?$/);
      const id = one && decodeURIComponent(one[1]);
      const session = id && all.get(id);
      if (!session) return reply("No such session.", 404);
      const rest = one[2] ?? "";
      if (!rest && request.method === "GET") return reply(session);
      if (!rest && request.method === "PATCH") {
        if (given.metadata) session.metadata = { ...(session.metadata ?? {}), ...given.metadata };
        if (given.permissions) session.permissions = given.permissions;
        seen.patched.push({ id, ...given });
        return reply(session);
      }
      if (rest === "/prompt") {
        seen.prompts.push({ to: id, id: given.id, text: given.text });
        messages.set(id, [...(messages.get(id) ?? []), { id: given.id, type: "user", text: given.text }]);
        return reply({});
      }
      if (rest === "/interrupt") {
        seen.interrupted.push(id);
        return reply({});
      }
      if (rest === "/permission" || rest === "/form") return reply([]);
      if (rest.startsWith("/message")) return reply([...(messages.get(id) ?? [])].reverse());
      reply({});
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  atEnd(() => { server.closeAllConnections(); server.close(); });
  return { seen, all, active, messages, target: { port: server.address().port, password: "pw" } };
}

const by = { bot: "bot_foreman0001", name: "Foreman" };
let eng;
beforeEach(async () => {
  for (const folder of [run, path.join(home, "box"), path.join(home, "bots"), path.join(home, "projects"), path.join(home, "worktrees")]) fs.rmSync(folder, { recursive: true, force: true });
  fs.mkdirSync(run, { recursive: true });
  fs.mkdirSync(path.join(home, "projects", "api"), { recursive: true });
  link.writeLink({ secret: crypto.randomBytes(32).toString("base64url"), key: k(here.key), relay: "wss://relay.test", name: "devbox", id: "devbox", mac: mac.pub, macs: [mac.pub], phones: [],
    legacy: { [mac.pub]: { at: 1, peers: [mac.peer, mini.peer, third.peer], moved: [] } } });
  // What each box says it takes: the third runs an older Kuvo Code.
  const takes = ["letters-read", "work.elsewhere", "work.elsewhere.start"];
  write(path.join(run, "peer-agents.json"), { [mini.pub]: { at: 1, heard: 1, kind: "machine", list: [], features: takes }, [mac.pub]: { at: 1, heard: 1, kind: "mac", list: [], features: takes }, [third.pub]: { at: 1, heard: 1, kind: "machine", list: [], features: ["letters-read", "work.elsewhere"] } });
  write(path.join(home, "box", "projects.json"), { projects: [{ directory: path.join(home, "projects", "api"), folders: [] }] });
  eng = await engine({ ses_user: { title: "The user's own" } });
  write(path.join(run, "engine.json"), eng.target);
});

let ids = 0;
const callID = () => `cal_start${String(++ids).padStart(12, "0")}`;
// What a lead's computer says of it: Foreman, a bot, in Full Access as it comes to there, with no rules.
const startAs = (more = {}) => ({ approval: "fullAccess", held: [], agent: null, model: { providerID: "p", id: "m1" }, autopilot: false, works: by, own: true, depth: 1, line: ["ses_lead"], limits: null, homes: { ses_lead: mini.pub }, ...more });
const startCall = (args = {}, start = {}, extra = {}) => ({ id: callID(), from: "ses_lead", tool: "start_session", args: { task: "Fix the sign-in.", project: "api", title: "Sign-in", ...args }, as: { name: "Foreman", bot: by, rules: [], free: true, start: startAs(start) }, made: Date.now(), at: Date.now(), ...extra });
async function take(call, sender = mini.peer) {
  const said = [];
  await link.takeCall(sender, call, { send: (_to, message) => said.push(message.delivered), targets: [eng.target], bridge: true, places: { readEngine: () => eng.target, bridge: () => null } });
  return said;
}
const answerOf = call => read(path.join(run, "outbox", "sending", `${call.id}-a.json`));
const sending = () => { try { return fs.readdirSync(path.join(run, "outbox", "sending")).filter(name => name.endsWith(".json")); } catch { return []; } };
const confirmFullAccess = () => write(path.join(home, "box", "approval.json"), { fullAccess: true });

test("a lead on another computer starts a session here as its own would: marked as its, told who it's from, and its news goes to the lead's computer", async () => {
  const call = startCall();
  // Said to be had before anything's made (so its lead's box knows it got there), and again once done.
  const said = [];
  await link.takeCall(mini.peer, call, { send: (_to, message) => said.push([message.delivered, eng.seen.made.length]), targets: [eng.target], bridge: true, places: { readEngine: () => eng.target, bridge: () => null } });
  assert.deepEqual(said, [[{ id: call.id, ok: true }, 0], [{ id: call.id, ok: true }, 1]]);
  assert.equal(eng.seen.made.length, 1);
  const made = eng.all.get(eng.seen.made[0].id);
  assert.equal(made.directory, path.join(home, "projects", "api"));
  const kuvo = made.metadata.kuvo;
  assert.equal(kuvo.startedBy, "ses_lead");
  assert.deepEqual(kuvo.by, by);
  assert.equal(kuvo.depth, 1);
  assert.deepEqual(kuvo.wake, ["finished", "asks"], "a bot hears of its sessions, wherever they are");
  assert.equal(kuvo.line, undefined, "one above is who started it, said already");
  assert.deepEqual(kuvo.lead, { box: "mini", key: mini.pub, name: "Foreman" });
  assert.equal(kuvo.call, call.id);
  assert.deepEqual(made.model, { providerID: "p", id: "m1" }, "on the lead's model, as there's an account for it here");
  // Its task, from the lead, saying where the lead is.
  assert.equal(eng.seen.prompts.length, 1);
  assert.match(eng.seen.prompts[0].text, /^\[Message from Foreman on mini · ses_lead\] \(To answer, use send_message to ses_lead\.\)\n\nFix the sign-in\./);
  // The lead lives on mini, as this box now knows: what its session says or asks goes there.
  assert.equal(read(path.join(run, "work", "homes.json")).ses_lead.key, mini.pub);
  // The answer goes back to the lead, as this computer's word, naming the session.
  const answer = answerOf(call);
  assert.equal(answer.to, "ses_lead");
  assert.equal(answer.refused, undefined);
  assert.match(answer.note.words, new RegExp(`^Started "Sign-in" in api \\(address ${made.id}\\)`));
});

test("in the lead's mode, with no more approval than the lead has nor more than this computer gives: Full Access only where it was confirmed here", async () => {
  const kuvoOf = async (args, start) => {
    const call = startCall(args, start);
    await take(call);
    const made = eng.seen.made.at(-1);
    return { kuvo: eng.all.get(made.id).metadata.kuvo, agent: made.agent, words: answerOf(call).note.words, refused: answerOf(call).refused };
  };
  // Full Access there, not confirmed here: less, kept as no more than that, and the lead hears why.
  const unconfirmed = await kuvoOf({}, {});
  assert.equal(unconfirmed.kuvo.approval, "auto");
  assert.notEqual(unconfirmed.kuvo.applied, "fullAccess");
  assert.match(unconfirmed.words, /Full Access hasn't been allowed on that computer yet: only the user can allow it, by picking Full Access once in a session there\./);
  // Confirmed here: Full Access.
  confirmFullAccess();
  const confirmed = await kuvoOf({}, {});
  assert.deepEqual([confirmed.kuvo.approval, confirmed.kuvo.applied], ["fullAccess", "fullAccess"]);
  assert.doesNotMatch(confirmed.words, /Full Access hasn't/);
  // A lead in Accept Edits asking for Full Access gets Accept Edits.
  const edits = await kuvoOf({ approval: "fullAccess" }, { approval: "acceptEdits" });
  assert.deepEqual([edits.kuvo.approval, edits.kuvo.applied], ["acceptEdits", "acceptEdits"]);
  // A lead that plans starts sessions that plan, and can't start one in Build.
  const plans = await kuvoOf({}, { agent: "plan" });
  assert.equal(plans.agent, "plan");
  const made = eng.seen.made.length;
  const build = startCall({ mode: "build" }, { agent: "plan" });
  await take(build);
  assert.equal(answerOf(build).refused, true);
  assert.match(answerOf(build).note.words, /This conversation is in Plan mode/);
  assert.equal(eng.seen.made.length, made);
  // Its model has no account here: on this computer's default, and it's told.
  const other = await kuvoOf({}, { model: { providerID: "q", id: "elsewhere" } });
  assert.equal(eng.seen.made.at(-1).model, undefined);
  assert.match(other.words, /It runs on the default model there: yours \(q\/elsewhere\) has no account on that computer\./);
});

test("the lead's Don't Allows hold here, and keep holding when this computer's rules are made again", async () => {
  confirmFullAccess();
  const push = { action: "shell", resource: "git push*", effect: "deny" };
  const call = startCall({}, { held: [push] });
  await take(call);
  const id = eng.seen.made[0].id;
  const hasPush = () => eng.all.get(id).permissions.some(rule => rule.action === push.action && rule.resource === push.resource && rule.effect === "deny");
  assert.ok(hasPush(), "made with it");
  assert.deepEqual(eng.all.get(id).metadata.kuvo.held, [push]);
  // This computer's Settings › Permissions change, and every conversation's rules are made again.
  write(path.join(home, "box", "opencode.json"), { permissions: [{ action: "shell", resource: "rm*", effect: "deny" }] });
  await link.reapplyApprovals(eng.target, null, true);
  assert.ok(eng.seen.patched.some(each => each.id === id && each.permissions), "they were made again");
  assert.ok(hasPush(), "the lead's Don't Allow is still there");
  assert.ok(eng.all.get(id).permissions.some(rule => rule.resource === "rm*" && rule.effect === "deny"), "and this computer's own");
  // Only a Don't Allow is carried: anything else in `held` isn't a call.
  const loose = startCall({}, { held: [{ action: "shell", resource: "*", effect: "allow" }] });
  const said = await take(loose);
  assert.deepEqual([said[0].ok, said[0].why], [false, "That isn't a call."]);
});

test("a start whose call comes again makes one session, and one answer", async () => {
  const call = startCall();
  await take(call);
  const first = answerOf(call);
  // Its receipt was lost: it comes again, sealed anew.
  assert.deepEqual(await take({ ...call, at: Date.now() }), [{ id: call.id, ok: true }]);
  assert.equal(eng.seen.made.length, 1);
  assert.equal(eng.seen.prompts.length, 1);
  assert.deepEqual(answerOf(call), first);
});

test("a start cut short as this box went down is finished from the step it got to, once; one a day old isn't started", async () => {
  // A whole start, for what its journal keeps at each step.
  const whole = startCall();
  await take(whole);
  const kept = read(path.join(run, "calls", `${whole.id}.json`));
  assert.ok(kept.done && kept.making && kept.session && kept.marked && kept.prompted);
  const journal = (id, change) => {
    const each = { ...structuredClone(kept), id, made: Date.now(), at: Date.now() };
    delete each.done;
    change(each);
    write(path.join(run, "calls", `${id}.json`), each);
    return each;
  };
  const answered = [];
  const resume = () => link.resumeStarts((each, done) => answered.push([each.id, done]), Date.now(), { readEngine: () => eng.target, bridge: () => null });
  const made = () => eng.seen.made.length, prompts = () => eng.seen.prompts.length;

  // Down before it was made: started now.
  const before = journal("cal_crash00000000001", each => { delete each.making; delete each.session; delete each.marked; delete each.prompted; });
  let [m, p] = [made(), prompts()];
  await resume();
  assert.deepEqual([made() - m, prompts() - p], [1, 1]);
  assert.equal(eng.all.get(eng.seen.made.at(-1).id).metadata.kuvo.call, before.id);

  // Down as it was made, before its journal heard: the session marked with its call is found, not made again.
  const ghost = { id: "ses_ghost", time: { created: Date.now(), updated: Date.now() }, directory: kept.making.folder, metadata: { kuvo: { call: "cal_crash00000000002", startedBy: "ses_lead" } } };
  eng.all.set("ses_ghost", ghost);
  journal("cal_crash00000000002", each => { delete each.session; delete each.marked; delete each.prompted; each.making.prompt.id = "msg_ghost"; });
  [m, p] = [made(), prompts()];
  await resume();
  assert.deepEqual([made() - m, prompts() - p], [0, 1]);
  assert.equal(eng.seen.prompts.at(-1).to, "ses_ghost");
  assert.deepEqual(eng.all.get("ses_ghost").metadata.kuvo.lead, { box: "mini", key: mini.pub, name: "Foreman" }, "and marked");

  // Made and marked, and told its task, before its journal heard: not told twice.
  eng.messages.set("ses_told", [{ id: "msg_told", type: "user", text: "task" }]);
  eng.all.set("ses_told", { id: "ses_told", time: { created: Date.now(), updated: Date.now() }, directory: "/work", metadata: {} });
  journal("cal_crash00000000003", each => { each.session = "ses_told"; each.prompted = false; each.making.prompt.id = "msg_told"; });
  [m, p] = [made(), prompts()];
  await resume();
  assert.deepEqual([made() - m, prompts() - p], [0, 0]);

  // Each was answered to its lead, once; and the next round leaves them be.
  assert.deepEqual(answered.map(([id]) => id).sort(), ["cal_crash00000000001", "cal_crash00000000002", "cal_crash00000000003"]);
  assert.ok(answered.every(([, done]) => !done.refused && /^Started "Sign-in"/.test(done.text)));
  [m, p] = [made(), prompts()];
  await resume();
  assert.deepEqual([made() - m, prompts() - p, answered.length], [0, 0, 3]);

  // A day on, nothing made yet: not started any more, and the lead hears it.
  journal("cal_crash00000000004", each => { delete each.making; delete each.session; delete each.marked; delete each.prompted; each.made = Date.now() - DAY - 60_000; });
  m = made();
  await resume();
  assert.equal(made(), m);
  assert.match(answered.at(-1)[1].text, /^The session wasn't started: this computer went down while starting it/);
});

test("while this computer doesn't let your other computers start work on it, nothing starts and the lead hears how to allow it; on a machine it's on until you say", async () => {
  assert.equal(link.otherComputersAllowed(), true, "a machine, from before: on");
  link.allowOtherComputers(false);
  for (const call of [startCall(), { ...startCall(), tool: "list_projects", args: {} }, { ...startCall(), tool: "list_models", args: {} }]) {
    const said = await take(call);
    assert.deepEqual([said[0].ok, said[0].why], [false, "devbox doesn't take work from your other computers. Ask the user to allow it in Settings › Permissions on devbox."], call.tool);
  }
  assert.equal(eng.seen.made.length, 0);
  // Stops still reach what's already here: the switch is about new work.
  eng.all.set("ses_left", { id: "ses_left", title: "Left", time: { created: 1, updated: 1 }, directory: "/work", metadata: { kuvo: { startedBy: "ses_lead", depth: 1 } } });
  const stop = { ...startCall(), tool: "stop_session", args: { session: "ses_left" } };
  assert.equal((await take(stop))[0].ok, true);
  assert.deepEqual(eng.seen.interrupted, ["ses_left"]);
  link.allowOtherComputers(true);
  assert.equal((await take(startCall()))[0].ok, true);
  assert.equal(eng.seen.made.length, 1);
});

test("the Mac with the app doesn't let other computers start work on it until you say", () => {
  const macHome = fs.mkdtempSync(path.join(home, "mac-"));
  const asked = code => spawnSync(process.execPath, ["--input-type=module", "-e", `const link = await import(${JSON.stringify(script)}); ${code}`], {
    env: { PATH: process.env.PATH, HOME: macHome, TMPDIR: macHome, KUVO_HOME: macHome, KUVO_BOX: "mac", KUVO_ENGINE_CONFIG: path.join(macHome, "opencode") }, encoding: "utf8",
  });
  const first = asked("console.log(link.otherComputersAllowed())");
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout.trim(), "false");
  const allowed = asked("link.allowOtherComputers(true); console.log(link.otherComputersAllowed())");
  assert.equal(allowed.stdout.trim(), "true");
});

test("its models and projects, read from another computer", async () => {
  const projects = { ...startCall(), tool: "list_projects", args: {} };
  await take(projects);
  const answer = answerOf(projects);
  assert.deepEqual(answer.read, {}, "for the tool that waits only, never a message later");
  assert.match(answer.text, /^Projects on devbox:\n- api: /);
  const models = { ...startCall(), tool: "list_models", args: {} };
  await take(models);
  assert.match(answerOf(models).text, /p\/m1 \(Model One\)/);
});

test("a line across three computers: the lead on one lists and stops what a session it started on a second started on this third", async () => {
  // The Mac's Foreman (ses_top) started ses_b1 on mini; ses_b1 starts one here.
  const call = { ...startCall({}, { line: ["ses_top", "ses_b1"], homes: { ses_top: mac.pub, ses_b1: mini.pub }, own: false, depth: 2 }), from: "ses_b1" };
  await take(call);
  const id = eng.seen.made[0].id;
  assert.deepEqual(eng.all.get(id).metadata.kuvo.line, ["ses_top", "ses_b1"]);
  assert.equal(read(path.join(run, "work", "homes.json")).ses_top.key, mac.pub, "where its top lives, as mini said");
  // From the Mac, ses_top lists it and stops it, though the one between isn't here.
  const call2 = (tool, args) => ({ id: callID(), from: "ses_top", tool, args, as: { name: "Foreman", bot: by, rules: [], free: true }, made: Date.now(), at: Date.now() });
  const list = call2("list_sessions", {});
  assert.equal((await take(list, mac.peer))[0].ok, true);
  assert.deepEqual(JSON.parse(answerOf(list).text).rows.map(row => row.session), [id]);
  const stop = call2("stop_session", { session: id });
  await take(stop, mac.peer);
  assert.deepEqual(eng.seen.interrupted, [id]);
  // Its rows go to both: to mini for ses_b1, and to the Mac for ses_top.
  const sent = [];
  await link.pushRows({ send: bytes => sent.push(bytes) }, link.readLink(), [eng.target], Date.now(), { force: true });
  const opened = to => sent.map(bytes => { try { return JSON.parse(link.openOneWay(link.readFrame(bytes.subarray(17)).body, to.key, link.publicOf(here.key)).payload.toString("utf8")).rows; } catch { return null; } }).find(Boolean);
  assert.deepEqual(opened(mini).leads.ses_b1.map(row => row.session), [id]);
  assert.deepEqual(opened(mac).leads.ses_top.map(row => row.session), [id]);
});

test("a bot's Stop All reaches its work here: what's working stops, the user's and what it started after don't, and nothing's said back", async () => {
  const T = Date.now();
  const at = (id, created, kuvo) => eng.all.set(id, { id, title: id, time: { created, updated: created }, directory: "/work", metadata: { kuvo } });
  at("ses_w1", T - 1000, { startedBy: "ses_lead", depth: 1, by, line: ["ses_lead"] });
  at("ses_w2", T - 1000, { startedBy: "ses_far", depth: 2, by, line: ["ses_lead", "ses_far"] });
  at("ses_late", T + 1000, { startedBy: "ses_lead", depth: 1, by, line: ["ses_lead"] });
  for (const id of ["ses_w1", "ses_w2", "ses_late", "ses_user"]) eng.active.add(id);
  const call = { id: callID(), from: "ses_lead", tool: "stop_work", args: { before: T }, as: { name: "Foreman", rules: [], free: false }, made: T, at: T };
  assert.deepEqual(await take(call), [{ id: call.id, ok: true }]);
  assert.deepEqual(eng.seen.interrupted.sort(), ["ses_w1", "ses_w2"]);
  assert.deepEqual(sending(), [], "no answer: it would wake the bot it stopped");

  // On the bot's own computer: Stop All leaves it for each computer that takes it, kept until it's there.
  write(path.join(home, "bots", "bot_foreman0001", "bot.json"), { kuvo: 1, id: "bot_foreman0001", name: "Foreman", job: "Runs the release.", look: { color: "sky", shape: "round", face: "calm" }, created: "2026-11-01T09:00:00Z", updated: "2026-11-01T09:00:00Z" });
  write(path.join(home, "bots", "bot_foreman0001", "session"), "ses_lead");
  eng.all.set("ses_lead", { id: "ses_lead", title: "Foreman", time: { created: 1, updated: 1 }, directory: "/work" });
  await link.stopBotWork("bot_foreman0001", [eng.target]);
  const left = sending().map(name => read(path.join(run, "outbox", "sending", name)));
  assert.deepEqual(left.map(each => [each.call.tool, each.peer, each.from, each.quiet]).sort(), [["stop_work", mac.pub, "ses_lead", true], ["stop_work", mini.pub, "ses_lead", true]].sort(), "not to the third, which runs an older Kuvo Code");
});

// ---- The caller's side ----

// A lead here: Foreman, kept in Full Access, which isn't confirmed on this computer, with a Don't Allow of its own.
function leadHere() {
  write(path.join(home, "bots", "bot_foreman0001", "bot.json"), { kuvo: 1, id: "bot_foreman0001", name: "Foreman", job: "Runs the release.", look: { color: "sky", shape: "round", face: "calm" }, created: "2026-11-01T09:00:00Z", updated: "2026-11-01T09:00:00Z" });
  write(path.join(home, "bots", "bot_foreman0001", "session"), "ses_lead");
  eng.all.set("ses_lead", { id: "ses_lead", title: "Foreman", time: { created: Date.now(), updated: Date.now() }, directory: "/work", model: { providerID: "p", id: "m1" },
    permissions: [{ action: "external_directory", resource: "*", effect: "allow" }, { action: "shell", resource: "git push*", effect: "deny" }], metadata: { kuvo: { approval: "fullAccess", applied: "fullAccess" } } });
}
const tool = (name, args, signal) => link.agentTool(name, args, "ses_lead", { readEngine: () => eng.target, bridge: () => null, step: 5, signal });

test("a start goes out with who's calling as this computer knows it, never as the agent says; its answer comes back to the tool", async () => {
  leadHere();
  const going = tool("start_session", { computer: "Mini", project: "api", task: "Fix the sign-in.", approval: "fullAccess", mode: "plan" });
  // The call, as it's left for mini.
  let call;
  while (!(call = sending().map(name => ({ name, ...read(path.join(run, "outbox", "sending", name)) })).find(each => each.call?.tool === "start_session"))) await new Promise(resolve => setTimeout(resolve, 5));
  const start = call.call.as.start;
  assert.notEqual(start.approval, "fullAccess", "its approval as it comes to here, not the one kept, nor what it asked");
  assert.deepEqual(start.held, [{ action: "shell", resource: "git push*", effect: "deny" }]);
  assert.deepEqual([start.works, start.own, start.depth, start.line], [by, true, 1, ["ses_lead"]]);
  assert.deepEqual(start.model, { providerID: "p", id: "m1" });
  assert.equal(call.peer, mini.pub);
  assert.deepEqual(call.call.args, { task: "Fix the sign-in.", project: "api", approval: "fullAccess", mode: "plan" }, "the agent's words go as what it asks for, and no more");
  // Mini answers.
  const id = call.name.slice(0, -5);
  write(path.join(run, "replies", `${id}.json`), { note: "[On mini] Started \"Sign-in\" in api (address ses_far): Plan. It's on it now." });
  const said = await going;
  assert.deepEqual(said, { text: "[On mini] Started \"Sign-in\" in api (address ses_far): Plan. It's on it now.", isError: false });
  // It lives on mini: a stop for it goes there at once.
  assert.equal(read(path.join(run, "work", "homes.json")).ses_far.key, mini.pub);
});

test("a start on a computer that isn't answering is refused at once, and nothing waits to go", async () => {
  leadHere();
  write(path.join(run, "peer-reach.json"), { [mini.pub]: Date.now() - 60_000 });
  const began = Date.now();
  const said = await tool("start_session", { computer: "mini", project: "api", task: "Fix the sign-in." });
  assert.ok(Date.now() - began < 2000, `took ${Date.now() - began} ms`);
  assert.deepEqual(said, { text: "mini isn't answering: it may be asleep, off or offline, so nothing was started. Nothing can wake it from here: try again once it's back (a wake-up can remind you), or do it on another computer.", isError: true });
  assert.deepEqual(sending(), []);
});

test("what the caller's computer refuses before anything goes", async () => {
  leadHere();
  const refusal = async args => {
    const said = await tool("start_session", { task: "Fix the sign-in.", ...args });
    assert.equal(said.isError, true, JSON.stringify(said));
    return said.text;
  };
  assert.equal(await refusal({ computer: "nowhere", project: "api" }), "There's no computer called nowhere. Your other computers: mac, mini, third.");
  assert.equal(await refusal({ computer: "third", project: "api" }), "third runs an older Kuvo Code that can't take work from other computers. Updating Kuvo Code on third lets it: ask the user.");
  assert.match(await refusal({ computer: "mini" }), /^Say where it works on mini: one of its projects \(project; list_projects with computer "mini" lists them\)/);
  // During a goal, its sessions stay on its bot's computer (until goals reach across computers).
  write(path.join(run, "work", "goals.json"), { goals: [{ id: "gol_1", bot: "bot_foreman0001", state: "running", goal: "Ship", steps: [], checks: [], spend: [] }] });
  assert.match(await refusal({ computer: "mini", project: "api" }), /^Your goal's sessions start on this machine for now/);
  fs.rmSync(path.join(run, "work", "goals.json"));
  assert.deepEqual(sending(), []);
  // Here, by this computer's own name: as start_session always did.
  const local = await tool("start_session", { computer: "devbox", project: "api", task: "Fix the sign-in." });
  assert.equal(local.isError, false, local.text);
  assert.equal(eng.seen.made.length, 1);
});

// ---- Found in review ----

test("a start that got there before its computer stopped answering isn't said to have not started: it may have", async () => {
  leadHere();
  const callFile = async () => {
    let name;
    while (!(name = sending().find(each => read(path.join(run, "outbox", "sending", each))?.call?.tool === "start_session"))) await new Promise(resolve => setTimeout(resolve, 5));
    return name;
  };
  const going = tool("start_session", { computer: "mini", project: "api", task: "Fix the sign-in." });
  // Mini says it has it (as it takes a start, before it makes anything), then stops answering
  // (its lid closed as it started the session).
  const name = await callFile();
  const file = path.join(run, "outbox", "sending", name);
  write(file, { ...read(file), sentTo: mini.pub });
  link.letterWent(mini.peer, { id: name.slice(0, -5), ok: true });
  write(path.join(run, "peer-reach.json"), { [mini.pub]: Date.now() });
  const said = await going;
  assert.equal(said.isError, true);
  assert.match(said.text, /^Couldn't confirm the session started on mini: it stopped answering \(it may be asleep, off or offline\) after the start went\. It may still have started, and if it did you'll hear as a message once mini is back\. Check with list_sessions before you start it again\.$/);
  assert.deepEqual(sending(), [], "and it isn't sent again");

  // The relay says it isn't there and mini never said it had it: it never got there.
  fs.rmSync(path.join(run, "peer-reach.json"));
  const bounced = tool("start_session", { computer: "mini", project: "api", task: "Fix the sign-in." });
  await callFile();
  write(path.join(run, "peer-reach.json"), { [mini.pub]: Date.now() });
  assert.match((await bounced).text, /^mini isn't answering: it may be asleep, off or offline, so nothing was started\./);
});


test("a start cut short isn't finished once this computer stopped taking work from yours, or yours was removed", async () => {
  const whole = startCall();
  await take(whole);
  const kept = read(path.join(run, "calls", `${whole.id}.json`));
  const pending = (id, sender = mini.pub) => {
    const each = { ...structuredClone(kept), id, sender, made: Date.now(), at: Date.now() };
    for (const key of ["done", "making", "session", "marked", "prompted"]) delete each[key];
    write(path.join(run, "calls", `${id}.json`), each);
  };
  const answered = [];
  const resume = () => link.resumeStarts((each, done) => answered.push([each.id, done]), Date.now(), { readEngine: () => eng.target, bridge: () => null });
  const made = eng.seen.made.length;
  link.allowOtherComputers(false);
  pending("cal_off0000000000001");
  await resume();
  link.allowOtherComputers(true);
  // From a computer that isn't one of yours any more.
  pending("cal_gone000000000001", crypto.randomBytes(32).toString("base64url"));
  await resume();
  assert.equal(eng.seen.made.length, made, "nothing made");
  assert.deepEqual(answered.map(([id, done]) => [id, done.refused]), [["cal_off0000000000001", true], ["cal_gone000000000001", true]]);
  assert.match(answered[0][1].text, /^The session wasn't started: this computer stopped taking work from your other computers before it was made\.$/);

  // Made and told its task before this box went down, then switched off: it did start, and says so.
  link.allowOtherComputers(false);
  const told = { ...structuredClone(kept), id: "cal_told000000000001", made: Date.now(), at: Date.now() };
  delete told.done;
  write(path.join(run, "calls", `${told.id}.json`), told);
  await resume();
  assert.deepEqual([answered.at(-1)[0], answered.at(-1)[1].refused], ["cal_told000000000001", false]);
  assert.match(answered.at(-1)[1].text, /^Started "Sign-in"/);
  link.allowOtherComputers(true);
});

test("a start finished after this box went down keeps where its lead's line lives, as one finished at once does", async () => {
  const whole = startCall({}, { line: ["ses_top", "ses_lead"], homes: { ses_top: mac.pub, ses_lead: mini.pub }, own: false, depth: 2 });
  await take(whole);
  const kept = read(path.join(run, "calls", `${whole.id}.json`));
  fs.rmSync(path.join(run, "work", "homes.json"), { force: true });
  const again = { ...structuredClone(kept), id: "cal_home000000000001", made: Date.now(), at: Date.now() };
  for (const key of ["done", "making", "session", "marked", "prompted"]) delete again[key];
  write(path.join(run, "calls", `${again.id}.json`), again);
  await link.resumeStarts(link.answerResumed, Date.now(), { readEngine: () => eng.target, bridge: () => null });
  assert.equal(read(path.join(run, "work", "homes.json"))?.ses_top?.key, mac.pub);
});

test("a start on a computer whose engine doesn't answer says so, not that it has no models", async () => {
  const down = startCall();
  const said = [];
  await link.takeCall(mini.peer, down, { send: (_to, message) => said.push(message.delivered), targets: [eng.target], bridge: true, places: { readEngine: () => ({ port: 1, password: "pw" }), bridge: () => null } });
  assert.match(answerOf(down).note.words, /^The engine on this machine isn't running\./);
});

test("a start's line must end with the lead that sends it, and a refused one leaves no word on where anyone lives", async () => {
  const forged = { ...startCall({}, { line: ["ses_someone", "ses_other"], homes: { ses_someone: third.pub } }) };
  assert.deepEqual((await take(forged)).map(each => [each.ok, each.why]), [[false, "That isn't a call."]]);
  // Refused there (no such project): the line's homes aren't kept.
  const refused = startCall({ project: "nowhere" }, { line: ["ses_top", "ses_lead"], homes: { ses_top: third.pub, ses_lead: mini.pub } });
  await take(refused);
  assert.equal(answerOf(refused).refused, true);
  assert.equal(read(path.join(run, "work", "homes.json"))?.ses_top, undefined);
  assert.equal(eng.seen.made.length, 0);
});

test("Stop All goes by when it was given, on the other computer's clock: a session started after it, by this one's, stays", async () => {
  const T = Date.now();
  // The bot's computer runs five minutes ahead of this one.
  const ahead = 5 * 60_000;
  eng.all.set("ses_old", { id: "ses_old", title: "Old", time: { created: T - 1000, updated: T }, directory: "/work", metadata: { kuvo: { startedBy: "ses_lead", depth: 1, by } } });
  eng.all.set("ses_new", { id: "ses_new", title: "New", time: { created: T + 60_000, updated: T }, directory: "/work", metadata: { kuvo: { startedBy: "ses_lead", depth: 1, by } } });
  eng.active.add("ses_old");
  eng.active.add("ses_new");
  const call = { id: callID(), from: "ses_lead", tool: "stop_work", args: { before: T + ahead }, as: { name: "Foreman", rules: [], free: false }, made: T + ahead, at: T + ahead };
  await take(call);
  assert.deepEqual(eng.seen.interrupted, ["ses_old"]);
});

// ---- Found in the security review ----

test("a start cut short is finished on its engine as it is now, after it started again elsewhere: found, not made twice; never while the engine isn't answering; and nothing keeps its password", async () => {
  const whole = startCall();
  await take(whole);
  const kept = read(path.join(run, "calls", `${whole.id}.json`));
  assert.equal(kept.making.target, undefined, "where the engine was isn't kept");
  assert.doesNotMatch(fs.readFileSync(path.join(run, "calls", `${whole.id}.json`), "utf8"), /"password"/);
  // The engine started again on another port, with another password.
  const moved = await engine({});
  write(path.join(run, "engine.json"), moved.target);
  // Made as the box went down, before its journal heard; kept by a box from before, with where its
  // engine was then.
  moved.all.set("ses_ghost", { id: "ses_ghost", time: { created: Date.now(), updated: Date.now() }, directory: kept.making.folder, metadata: { kuvo: { call: "cal_moved0000000001", startedBy: "ses_lead" } } });
  const journal = { ...structuredClone(kept), id: "cal_moved0000000001", made: Date.now(), at: Date.now() };
  for (const key of ["done", "session", "marked", "prompted"]) delete journal[key];
  journal.making.target = eng.target;
  journal.making.prompt.id = "msg_moved";
  write(path.join(run, "calls", `${journal.id}.json`), journal);
  const answered = [];
  // Its engine not answering yet, as it starts again: left for a later round, not refused for good.
  await link.resumeStarts((each, done) => answered.push([each.id, done]), Date.now(), { readEngine: () => ({ port: 1, password: "old" }), bridge: () => null });
  assert.deepEqual(answered, []);
  assert.equal(read(path.join(run, "calls", `${journal.id}.json`)).done, undefined);
  assert.equal(moved.seen.made.length + eng.seen.made.length, 1, "nothing made meanwhile");
  // Answering: the session it made is found there and told its task, once.
  await link.resumeStarts((each, done) => answered.push([each.id, done]), Date.now(), { readEngine: () => moved.target, bridge: () => null });
  assert.deepEqual([moved.seen.made.length, eng.seen.made.length], [0, 1], "not made again");
  assert.deepEqual(moved.seen.prompts.map(each => [each.to, each.id]), [["ses_ghost", "msg_moved"]]);
  assert.equal(answered.length, 1);
  assert.match(answered[0][1].text, /^Started "Sign-in" in api \(address ses_ghost\)/);
  const after = fs.readFileSync(path.join(run, "calls", `${journal.id}.json`), "utf8");
  assert.doesNotMatch(after, /"password"|"target"/, "the old journal's engine and password are gone");
});

test("one started for a lead on another computer never rises to Full Access later, when Full Access is confirmed here for something else", async () => {
  const call = startCall();
  await take(call);
  const id = eng.seen.made[0].id;
  // (Auto, which asks first while the sandbox isn't running, as it isn't in this test.)
  assert.equal(eng.all.get(id).metadata.kuvo.approval, "auto");
  assert.notEqual(eng.all.get(id).metadata.kuvo.applied, "fullAccess");
  // You confirm Full Access here, for a session of your own; every conversation's rules are made again.
  confirmFullAccess();
  await link.reapplyApprovals(eng.target, null);
  await link.reapplyApprovals(eng.target, null, true);
  assert.equal(eng.all.get(id).metadata.kuvo.approval, "auto");
  assert.notEqual(eng.all.get(id).metadata.kuvo.applied, "fullAccess");
  assert.notEqual(link.approvalOf(eng.all.get(id), { agents: false, bot: true }).effective, "fullAccess");
});

test("a start under way when you switch your other computers off here isn't made", async () => {
  const call = startCall();
  // Switched off as the start reads what's here, after its call was let in: the engine, through a
  // stand-in in front of it that switches it off as the start asks which accounts it has.
  let switched = false;
  const proxy = http.createServer((request, response) => {
    if (request.url === "/api/provider" && !switched) { switched = true; link.allowOtherComputers(false); }
    const forward = http.request({ host: "127.0.0.1", port: eng.target.port, path: request.url, method: request.method, headers: request.headers }, answer => {
      response.writeHead(answer.statusCode, answer.headers);
      answer.pipe(response);
    });
    request.pipe(forward);
  });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
  atEnd(() => { proxy.closeAllConnections(); proxy.close(); });
  const via = { port: proxy.address().port, password: "pw" };
  const said = [];
  await link.takeCall(mini.peer, call, { send: (_to, message) => said.push(message.delivered), targets: [via], bridge: true, places: { readEngine: () => via, bridge: () => null } });
  assert.equal(switched, true);
  assert.equal(eng.seen.made.length, 0, "nothing made");
  assert.equal(answerOf(call).refused, true);
  assert.equal(answerOf(call).note.words, "devbox doesn't take work from your other computers. Ask the user to allow it in Settings › Permissions on devbox.");
  link.allowOtherComputers(true);
});

test("a start that went out and got no word back before its computer stopped answering may have started: said so, and its count is kept", async () => {
  leadHere();
  const counts = () => (read(path.join(run, "tool-limits.json"))?.botSessions?.["bot:bot_foreman0001"] ?? []).length;
  const before = counts();
  const going = tool("start_session", { computer: "mini", project: "api", task: "Fix the sign-in." });
  let name;
  while (!(name = sending().find(each => read(path.join(run, "outbox", "sending", each))?.call?.tool === "start_session"))) await new Promise(resolve => setTimeout(resolve, 5));
  // It went to mini (no word back), then the relay says mini isn't there.
  const file = path.join(run, "outbox", "sending", name);
  write(file, { ...read(file), sentTo: mini.pub });
  write(path.join(run, "peer-reach.json"), { [mini.pub]: Date.now() });
  const said = await going;
  assert.match(said.text, /^Couldn't confirm the session started on mini: it stopped answering .* It may still have started/);
  assert.doesNotMatch(said.text, /nothing was started/);
  assert.equal(counts(), before + 1, "it may have started: still counted");
});

test("a start cut short after its worktree was made goes on in that worktree, not a second", async () => {
  // The worktree it made, kept with its call, as the box went down before it made the session.
  const tree = path.join(home, "worktrees", "api-sign-in");
  fs.mkdirSync(tree, { recursive: true });
  const call = startCall({ worktree: true });
  const journal = { id: call.id, from: "ses_lead", sender: mini.pub, computer: "mini", name: "Foreman", given: { task: "Fix the sign-in.", project: "api", title: "Sign-in", worktree: true }, start: startAs(), made: Date.now(), at: Date.now(),
    tree: { folder: tree, root: tree, branch: "kuvo/sign-in" } };
  write(path.join(run, "calls", `${call.id}.json`), journal);
  const answered = [];
  await link.resumeStarts((each, done) => answered.push([each.id, done]), Date.now(), { readEngine: () => eng.target, bridge: () => null });
  // (api isn't a git repository: a second worktree couldn't be made at all.)
  assert.equal(answered.length, 1);
  assert.equal(answered[0][1].refused, false, answered[0][1].text);
  assert.equal(eng.seen.made.length, 1);
  assert.equal(eng.seen.made[0].directory, tree);
  assert.match(answered[0][1].text, /worktree kuvo\/sign-in/);
});

// ---- Found in review of those fixes ----

// A journal kept as a whole start's would be at the step `change` leaves it at.
async function cutShort(id, change, args = {}) {
  const whole = startCall(args);
  await take(whole);
  const kept = { ...structuredClone(read(path.join(run, "calls", `${whole.id}.json`))), id, made: Date.now(), at: Date.now() };
  for (const key of ["done", "making", "session", "marked", "prompted"]) delete kept[key];
  change(kept);
  write(path.join(run, "calls", `${id}.json`), kept);
  return kept;
}

test("two rounds at once, as an engine just starting again takes its time to answer, make a start cut short once", async () => {
  await cutShort("cal_twice0000000001", () => {});
  // The engine, slow to answer which accounts it has as it starts again.
  const slow = http.createServer((request, response) => {
    const forward = () => {
      const on = http.request({ host: "127.0.0.1", port: eng.target.port, path: request.url, method: request.method, headers: request.headers }, answer => {
        response.writeHead(answer.statusCode, answer.headers);
        answer.pipe(response);
      });
      request.pipe(on);
    };
    if (request.url === "/api/provider") setTimeout(forward, 300); else forward();
  });
  await new Promise(resolve => slow.listen(0, "127.0.0.1", resolve));
  atEnd(() => { slow.closeAllConnections(); slow.close(); });
  const via = { port: slow.address().port, password: "pw" };
  const made = eng.seen.made.length;
  const answered = [];
  const round = () => link.resumeStarts((each, done) => answered.push([each.id, done]), Date.now(), { readEngine: () => via, bridge: () => null });
  await Promise.all([round(), round(), round()]);
  assert.equal(eng.seen.made.length - made, 1, "one session");
  assert.equal(answered.length, 1, "and one answer");
});

test("a day on, one cut short is said as far as it got, without its engine: made but not told; or may have been made, where that can't be asked", async () => {
  const dayAgo = Date.now() - DAY - 60_000;
  const down = { readEngine: () => ({ port: 1, password: "pw" }), bridge: () => null };
  const answered = [];
  const resume = places => link.resumeStarts((each, done) => answered.push([each.id, done]), Date.now(), places);
  // Made and marked, but not told its task, and its engine hasn't answered since.
  await cutShort("cal_untold000000001", each => {
    each.making = structuredClone(read(path.join(run, "calls", `${eng.seen.made.at(-1).metadata.kuvo.call}.json`)).making);
    each.session = "ses_untold";
    each.marked = true;
    each.made = dayAgo;
  });
  // Being made as the box went down: whether it was can't be asked.
  await cutShort("cal_maybe0000000001", each => {
    each.making = structuredClone(read(path.join(run, "calls", `${eng.seen.made.at(-1).metadata.kuvo.call}.json`)).making);
    each.made = dayAgo;
  });
  const made = eng.seen.made.length;
  await resume(down);
  assert.equal(eng.seen.made.length, made);
  const said = Object.fromEntries(answered.map(([id, done]) => [id, done]));
  assert.match(said.cal_untold000000001.text, /^Started a session \(address ses_untold\), but it wasn't given its task: this computer went down while starting it, and it's been over a day since you asked\./);
  assert.match(said.cal_maybe0000000001.text, /^It may not have been started: .*whether the session was made can't be told now\./);
  assert.doesNotMatch(said.cal_maybe0000000001.text, /wasn't started/);
  // Done, so the next round leaves them be (and they go in time).
  await resume(down);
  assert.equal(answered.length, 2);
});

// The project api, a repository, and a worktree of it the box made for a start before it went down.
async function apiWorktree() {
  const api = path.join(home, "projects", "api");
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: api, env });
  fs.writeFileSync(path.join(api, "README.md"), "# API\n");
  execFileSync("git", ["add", "-A"], { cwd: api, env });
  execFileSync("git", ["commit", "-q", "-m", "First"], { cwd: api, env });
  const tree = (await link.answerWorktrees("POST", "kuvo/worktrees", { project: api }, eng.target, undefined, null)).value;
  assert.ok(tree.root && fs.existsSync(tree.root), JSON.stringify(tree));
  return tree;
}

test("the worktree made for a start that's then not to be made, as you switched starts off meanwhile, goes again", async () => {
  const tree = await apiWorktree();
  write(path.join(run, "calls", "cal_tree00000000001.json"), { id: "cal_tree00000000001", from: "ses_lead", sender: mini.pub, computer: "mini", name: "Foreman", given: { task: "Fix the sign-in.", project: "api", worktree: true }, start: startAs(), made: Date.now(), at: Date.now(),
    tree: { folder: tree.folder, root: tree.root, branch: tree.branch } });
  link.allowOtherComputers(false);
  const answered = [];
  // Its engine not running yet, as the box starts again: the lead hears at once, and the worktree,
  // which can't be taken away yet, stays with its call for later.
  await link.resumeStarts((each, done) => answered.push([each.id, done]), Date.now(), { readEngine: () => ({ port: 1, password: "pw" }), bridge: () => null });
  assert.match(answered[0][1].text, /^The session wasn't started: this computer stopped taking work from your other computers before it was made\./);
  assert.ok(fs.existsSync(tree.root));
  assert.equal(read(path.join(run, "calls", "cal_tree00000000001.json")).tree.root, tree.root);
  // Once it runs: gone, and the lead isn't told twice.
  await link.resumeStarts((each, done) => answered.push([each.id, done]), Date.now(), { readEngine: () => eng.target, bridge: () => null });
  link.allowOtherComputers(true);
  assert.equal(answered.length, 1);
  assert.equal(fs.existsSync(tree.root), false, "its worktree is gone");
  assert.equal(read(path.join(run, "calls", "cal_tree00000000001.json")).tree, undefined);
});

test("a bot's session carried on with the coding agents is one of its starts for the day, not two", async () => {
  // Started today and carried on: the engine's copy, archived, and the coding agents' one.
  const now = Date.now();
  eng.all.set("ses_left", { id: "ses_left", time: { created: now, updated: now }, directory: "/work", metadata: { "kuvo.archived": true, "kuvo.carriedTo": "ses_carried", kuvo: { startedBy: "ses_lead", by, depth: 1 } } });
  eng.all.set("ses_carried", { id: "ses_carried", time: { created: now, updated: now }, directory: "/work", metadata: { kuvo: { startedBy: "ses_lead", by, depth: 1, carriedFrom: "ses_left" } } });
  // Two a day, as you set for Foreman: one so far, so this one starts.
  const call = startCall({}, { limits: { perDay: 2 } });
  await take(call);
  assert.equal(answerOf(call).refused, undefined, answerOf(call).note.words);
  assert.equal(eng.seen.made.length, 1);
});

test("a worktree made for a start that may have been made stays where a session is in it after all, idle, never told its task", async () => {
  const tree = await apiWorktree();
  // A day on: being made as the box went down, and its engine can't be asked.
  await cutShort("cal_idle00000000001", each => {
    each.making = { ...structuredClone(read(path.join(run, "calls", `${eng.seen.made.at(-1).metadata.kuvo.call}.json`)).making), folder: tree.folder };
    each.tree = { folder: tree.folder, root: tree.root, branch: tree.branch };
    each.made = Date.now() - DAY - 60_000;
  });
  const answered = [];
  await link.resumeStarts((each, done) => answered.push([each.id, done]), Date.now(), { readEngine: () => ({ port: 1, password: "pw" }), bridge: () => null });
  assert.match(answered.at(-1)[1].text, /^It may not have been started/);
  // It was: its session is in the worktree (made with a mark its journal never heard of, as the
  // box went down), idle. The next round leaves the worktree be.
  eng.all.set("ses_idle", { id: "ses_idle", time: { created: Date.now(), updated: Date.now() }, directory: tree.folder, metadata: {} });
  await link.resumeStarts((each, done) => answered.push([each.id, done]), Date.now(), { readEngine: () => eng.target, bridge: () => null });
  assert.ok(fs.existsSync(tree.root), "the session's worktree stays");
  assert.equal(read(path.join(run, "calls", "cal_idle00000000001.json")).tree, undefined, "and isn't tried again");
});

test("a bot's own session here carried on with the coding agents is still one of its starts for the day", async () => {
  // Started by the bot here, and carried on: its copy there isn't marked as the bot's.
  const now = Date.now();
  eng.all.set("ses_mine", { id: "ses_mine", time: { created: now, updated: now }, directory: "/work", metadata: { "kuvo.archived": true, "kuvo.carriedTo": "ses_mine2", kuvo: { startedBy: "ses_lead", by, depth: 1 } } });
  eng.all.set("ses_mine2", { id: "ses_mine2", time: { created: now, updated: now }, directory: "/work", metadata: { kuvo: { carriedFrom: "ses_mine" } } });
  // One a day, as you set: that one was it.
  const call = startCall({}, { limits: { perDay: 1 } });
  await take(call);
  assert.equal(answerOf(call).refused, true);
  assert.match(answerOf(call).note.words, /new session a day at most/);
  assert.equal(eng.seen.made.length, 0);
});

test("a worktree made for a start going to the coding agents stays while their bridge is down, as it can't say whether its session is in it", async () => {
  const tree = await apiWorktree();
  await cutShort("cal_agent0000000001", each => {
    each.making = { ...structuredClone(read(path.join(run, "calls", `${eng.seen.made.at(-1).metadata.kuvo.call}.json`)).making), folder: tree.folder, agents: true };
    each.tree = { folder: tree.folder, root: tree.root, branch: tree.branch };
    each.made = Date.now() - DAY - 60_000;
  });
  const answered = [];
  // The engine answers; the coding agents' bridge doesn't run yet.
  await link.resumeStarts((each, done) => answered.push([each.id, done]), Date.now(), { readEngine: () => eng.target, bridge: () => null });
  await link.resumeStarts((each, done) => answered.push([each.id, done]), Date.now(), { readEngine: () => eng.target, bridge: () => null });
  assert.equal(answered.length, 1, "the lead hears once");
  assert.ok(fs.existsSync(tree.root), "its worktree stays");
  assert.equal(read(path.join(run, "calls", "cal_agent0000000001.json")).tree.root, tree.root, "to be tried again once the bridge runs");
});

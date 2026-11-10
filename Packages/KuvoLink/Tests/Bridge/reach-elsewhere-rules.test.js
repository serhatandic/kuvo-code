// What a box takes of another box's calls for the sessions a lead left on it, and from whom
// (PROTOCOL.md, "Peers", `call`; design section 6): only from your own computers; only for a lead
// that isn't one of its own, nor known to live on another computer; only that lead's sessions; an
// allow only as far as the lead could go itself and as far as this box's own rules (Ask and Don't
// Allow alike) would let it, and never for a session in Ask First; and nothing a call can't reach. A call sent again is run once and answered once, and calls aren't
// counted as messages. Its rows of a lead's sessions go to that lead's computer only, until it has
// them; calls kept for a box that's away go one a minute, and what's let go is told to the lead.
//
// It runs in one process, on a given clock: this box is the real link, and the other boxes are
// scripted. The engines are stand-ins.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/reach-elsewhere-rules.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { atEnd, removeAtEnd } from "./at-end.js";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-reach-rules-")));
process.env.KUVO_HOME = home;
removeAtEnd(home);
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");

const DAY = 86_400_000, MINUTE = 60_000;
const run = path.join(home, "run");
const k = key => key.toString("base64url");
const box = (kind, id) => {
  const key = link.newKey();
  const address = k(link.addressOf(crypto.randomBytes(32)));
  return { key, pub: k(link.publicOf(key)), address, peer: { key: k(link.publicOf(key)), address, name: id ?? kind, kind, ...(id ? { id } : {}) } };
};
const here = box("machine", "devbox"), mac = box("mac"), mini = box("machine", "mini"), third = box("machine", "third"), stranger = box("machine", "stranger");
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
};
const read = file => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };

// An engine with these sessions: what each was sent, interrupted, and how each ask was answered.
async function engine(sessions) {
  const seen = { prompts: [], interrupted: [], replied: [], asks: new Map(), messages: new Map() };
  const all = new Map(Object.entries(sessions).map(([id, each]) => [id, { id, time: { created: 1, updated: 1 }, directory: "/work", ...each }]));
  const server = http.createServer((request, response) => {
    let text = "";
    request.on("data", chunk => { text += chunk; });
    request.on("end", () => {
      const given = text ? JSON.parse(text) : {};
      const reply = (value, status = 200) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(status < 400 ? { data: value } : { message: value }));
      const url = new URL(request.url, "http://x");
      if (url.pathname === "/api/session" && request.method === "GET") return reply([...all.values()].filter(each => !each.parentID));
      if (url.pathname === "/api/session/active") return reply({});
      const one = url.pathname.match(/^\/api\/session\/([^/]+)(\/.*)?$/);
      const id = one && decodeURIComponent(one[1]);
      const session = id && all.get(id);
      if (!session) return reply("No such session.", 404);
      const rest = one[2] ?? "";
      if (!rest && request.method === "GET") return reply(session);
      if (!rest && request.method === "PATCH") {
        session.metadata = given.metadata;
        return reply(session);
      }
      if (rest === "/prompt") {
        seen.prompts.push({ to: id, text: given.text, metadata: given.metadata });
        return reply({});
      }
      if (rest === "/interrupt") {
        seen.interrupted.push(id);
        return reply({});
      }
      if (rest === "/permission") return reply((seen.asks.get(id) ?? []).map(ask => ({ ...ask, sessionID: id })));
      if (rest === "/form") return reply([]);
      const answered = rest.match(/^\/permission\/([^/]+)\/reply$/);
      if (answered) {
        seen.replied.push({ session: id, ask: decodeURIComponent(answered[1]), ...given });
        return reply({});
      }
      if (rest === "/message") return reply(seen.messages.get(id) ?? []);
      reply({});
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  atEnd(() => { server.closeAllConnections(); server.close(); });
  return { seen, all, target: { port: server.address().port, password: "pw" } };
}

const by = { bot: "bot_foreman0001", name: "Foreman" };
// A session the lead left here, in Accept Edits unless said (one in Ask First is always the user's to
// answer, so an allow for it is refused whatever the lead's rules say, and one started here runs in Auto,
// which asks first while no sandbox runs).
const MODES = { askFirst: [{ action: "shell", resource: "*", effect: "ask" }, { action: "edit", resource: "*", effect: "ask" }], acceptEdits: [{ action: "shell", resource: "*", effect: "ask" }] };
const left = (title, extra = {}, approval = "acceptEdits") => ({ title, permissions: MODES[approval], metadata: { kuvo: { startedBy: "ses_lead", depth: 1, by, approval, applied: approval } }, ...extra });
let eng;
beforeEach(async () => {
  fs.rmSync(run, { recursive: true, force: true });
  fs.rmSync(path.join(home, "box"), { recursive: true, force: true });
  fs.mkdirSync(run, { recursive: true });
  link.writeLink({ secret: crypto.randomBytes(32).toString("base64url"), key: k(here.key), relay: "wss://relay.test", name: "devbox", id: "devbox", mac: mac.pub, macs: [mac.pub], phones: [],
    legacy: { [mac.pub]: { at: 1, peers: [mac.peer, mini.peer, third.peer], moved: [] } } });
  // What each box says it takes.
  write(path.join(run, "peer-agents.json"), { [mini.pub]: { at: 1, heard: 1, kind: "machine", list: [], features: ["letters-read", "work.elsewhere"] }, [third.pub]: { at: 1, heard: 1, kind: "machine", list: [], features: ["letters-read"] } });
  eng = await engine({ ses_left: left("Sign-in"), ses_billing: left("Billing"), ses_user: { title: "The user's own" }, ses_here: { title: "A lead of this box's own" } });
  write(path.join(run, "engine.json"), eng.target);
});

let ids = 0;
const callOf = (tool, args = {}, extra = {}) => ({ id: `cal_test${String(++ids).padStart(14, "0")}`, from: "ses_lead", tool, args, as: { name: "Foreman", bot: by, rules: [], free: true }, made: Date.now(), at: Date.now(), ...extra });
// A call taken here, from `sender`: what this box said of it (`delivered`).
async function take(call, sender = mini.peer, extra = {}) {
  const said = [];
  await link.takeCall(sender, call, { send: (_to, message) => said.push(message.delivered), targets: [eng.target], bridge: true, ...extra });
  return said;
}
// What a box does on its own once it's told, looked at again until it's there (the test's time limit ends it).
async function arrives(found) {
  for (;;) {
    const value = found();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
const sending = () => { try { return fs.readdirSync(path.join(run, "outbox", "sending")).filter(name => name.endsWith(".json")); } catch { return []; } };
const answerOf = call => read(path.join(run, "outbox", "sending", `${call.id}-a.json`));

test("a call sent again is run once, and its answer reaches the lead once", async () => {
  const call = callOf("stop_session", { session: "ses_left" });
  assert.deepEqual(await take(call), [{ id: call.id, ok: true }]);
  assert.deepEqual(eng.seen.interrupted, ["ses_left"]);
  const answer = answerOf(call);
  assert.equal(answer.answers, call.id);
  assert.equal(answer.to, "ses_lead");
  assert.equal(answer.peer, mini.pub);
  assert.equal(answer.note.words, "Stopped \"Sign-in\".");
  assert.deepEqual(answer.note.about, ["ses_left"]);
  // Its receipt was lost, and it comes again: there, not run again, and still one answer.
  assert.deepEqual(await take({ ...call, at: Date.now() }), [{ id: call.id, ok: true }]);
  assert.deepEqual(eng.seen.interrupted, ["ses_left"]);
  assert.deepEqual(sending(), [`${call.id}-a.json`]);

  // On the lead's computer (this box, in its place here), with no tool waiting any more: the same
  // answer, come twice, reaches the lead once.
  eng.all.set("ses_lead", { id: "ses_lead", title: "Foreman" });
  const letter = { id: `${call.id}-a`, from: null, to: "ses_lead", text: answer.text, answers: call.id, wait: false, note: answer.note, at: Date.now(), made: Date.now() };
  for (let time = 0; time < 2; time++) {
    const said = [];
    await link.takeLetter(mini.peer, { ...letter, at: Date.now() }, { send: (_to, message) => said.push(message.delivered), targets: [eng.target], peers: [mini.peer], told: {}, moved: new Map(), wait: 1 });
    assert.equal(said[0].ok, true);
  }
  const told = eng.seen.prompts.filter(each => each.to === "ses_lead");
  assert.equal(told.length, 1);
  assert.equal(told[0].text, "[On devbox] Stopped \"Sign-in\".");
});

test("what a box refuses, and from whom", async () => {
  // A box that isn't one of yours: its mail isn't even opened.
  const said = [];
  const host = { send: bytes => said.push(bytes) };
  const call = callOf("stop_session", { session: "ses_left" });
  const sealed = link.sealOneWay(Buffer.from(JSON.stringify({ call, at: Date.now() })), stranger.key, link.publicOf(here.key)).message;
  link.receiveMail(sealed, host, (sender, payload) => link.peerMail(sender, payload, host, () => ({ targets: [eng.target], bridge: true })));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([said.length, eng.seen.interrupted.length], [0, 0]);

  // For a lead that's one of this box's own: no other box speaks for it.
  const own = await take(callOf("stop_session", { session: "ses_left" }, { from: "ses_here" }));
  assert.deepEqual([own[0].ok, own[0].retry, own[0].why], [false, undefined, "That conversation is on this computer: another can't speak for it."]);
  // For a lead this box knows lives on another computer than the one calling: not now (its word may be stale).
  write(path.join(run, "work", "homes.json"), { ses_elsewhere: { key: third.pub, at: Date.now() } });
  const claimed = await take(callOf("stop_session", { session: "ses_left" }, { from: "ses_elsewhere" }));
  assert.deepEqual([claimed[0].ok, claimed[0].retry], [false, true]);
  assert.equal(eng.seen.interrupted.length, 0);

  // Only the lead's own sessions: not the user's.
  const notTheirs = callOf("stop_session", { session: "ses_user" });
  assert.equal((await take(notTheirs))[0].ok, true);
  assert.equal(answerOf(notTheirs).refused, true);
  assert.match(answerOf(notTheirs).note.words, /isn't yours to stop: ask the user/);
  assert.equal(eng.seen.interrupted.length, 0);

  // Nothing a call can't reach: starting work, making a project, the vault, a sandbox ask.
  for (const tool of ["start_session", "make_project", "vault_ask", "sandbox_ask", "send_message"]) {
    const refused = await take(callOf(tool, { task: "Anything." }));
    assert.deepEqual([refused[0].ok, refused[0].why], [false, "That isn't something another computer can do here."], tool);
  }
  // A replay from days ago: not taken (the real one, sealed anew, comes again).
  const replay = await take(callOf("stop_session", { session: "ses_left" }, { at: Date.now() - 2 * DAY }));
  assert.deepEqual([replay[0].ok, replay[0].retry], [false, true]);
  // A session that isn't here: said so, for a call sent to every box in case it was.
  const nowhere = await take(callOf("stop_session", { session: "ses_nowhere" }));
  assert.deepEqual([nowhere[0].ok, nowhere[0].why], [false, "There's no session ses_nowhere on this computer."]);
  assert.equal(eng.seen.interrupted.length, 0);
});

test("a lead that moved from here is reached from where it went as soon as it's switched to there, while its original here is still being let go", async () => {
  // The bot moved from this box to mini: its original's still here as it's let go (`finishing`).
  eng.all.set("ses_lead", { id: "ses_lead", title: "Foreman", time: { created: 1, updated: 1 }, directory: "/work" });
  const move = stage => write(path.join(run, "moves", "mov_test0000000001.json"), { id: "mov_test0000000001", kind: "bot", thing: by.bot, name: "Foreman", from: here.pub, to: mini.pub, peer: mini.pub, role: "from", stage, step: stage === "finishing" ? "done" : "switch", sessions: ["ses_lead"], wasPaused: false, tries: 0, started: Date.now() });
  move("finishing");
  const list = callOf("list_sessions");
  assert.deepEqual(await take(list), [{ id: list.id, ok: true }]);
  assert.deepEqual(JSON.parse(answerOf(list).text).rows.map(row => row.session).sort(), ["ses_billing", "ses_left"]);
  const stop = callOf("stop_session", { session: "ses_left" });
  assert.deepEqual(await take(stop), [{ id: stop.id, ok: true }]);
  assert.deepEqual(eng.seen.interrupted, ["ses_left"]);
  // Asked to switch, not heard back yet: its copy there runs only once it's switched, so a call from it there says it is.
  move("switching");
  const switching = callOf("list_sessions");
  assert.deepEqual(await take(switching), [{ id: switching.id, ok: true }]);
  // From any other box, it's still moving: not now.
  const elsewhere = callOf("list_sessions");
  const [fromThird] = await take(elsewhere, third.peer);
  assert.deepEqual([fromThird.ok, fromThird.retry], [false, true]);
  // Still on its way (its copy there held): not now, from there either.
  move("copying");
  const early = callOf("list_sessions");
  const [copying] = await take(early);
  assert.deepEqual([copying.ok, copying.retry], [false, true]);
});

test("a message from a lead that moved from here is from it, by its name and with a way back, as soon as it's switched to there, while its original here is still being let go", async () => {
  eng.all.set("ses_lead", { id: "ses_lead", title: "Foreman", time: { created: 1, updated: 1 }, directory: "/work" });
  const move = stage => write(path.join(run, "moves", "mov_test0000000002.json"), { id: "mov_test0000000002", kind: "bot", thing: by.bot, name: "Foreman", from: here.pub, to: mini.pub, peer: mini.pub, role: "from", stage, step: stage === "finishing" ? "done" : stage === "switching" ? "switch" : "parts", sessions: ["ses_lead"], wasPaused: false, tries: 0, started: Date.now() });
  const letter = { from: "ses_lead", to: "ses_user", text: "How's it going?", wait: false };
  const answers = [];
  const send = async (sender, told, extra = {}) => {
    const said = [];
    await link.takeLetter(sender, { ...letter, id: "ltr_" + crypto.randomBytes(6).toString("hex"), at: Date.now(), ...extra }, { send: (_to, message) => said.push(message.delivered), answer: each => answers.push(each), targets: [eng.target], peers: [mini.peer, third.peer], told, moved: new Map(), wait: 1 });
    assert.equal(said[0].ok, true, said[0].why);
    return eng.seen.prompts.at(-1).text;
  };
  const listed = { [mini.pub]: { at: 1, kind: "machine", list: [{ session: "ses_lead", name: "Foreman", kind: "bot", id: by.bot }] } };
  const fromLead = link.composeLetter("Foreman", "ses_lead", "How's it going?", false);
  const fromSomeone = box => link.composeLetter(`an agent on ${box}`, "unknown", "How's it going?", false);
  move("finishing");
  assert.equal(await send(mini.peer, listed), fromLead, "as the box it went to lists it");
  assert.equal(await send(mini.peer, {}), fromLead, "before that box has listed it: by the name it moved with");
  assert.equal(await send(third.peer, {}), fromSomeone("third"), "from any other box, it isn't");
  // Waiting for an answer: it goes back to it, on the box it went to.
  eng.seen.messages.set("ses_user", [{ id: "msg_zzzzzzzzzzzz", type: "assistant", content: [{ type: "text", text: "Going well." }] }]);
  assert.equal(await send(mini.peer, {}, { wait: true }), link.composeLetter("Foreman", "ses_lead", "How's it going?", true));
  assert.deepEqual(answers.map(each => [each.to, each.peer, each.text]), [["ses_lead", mini.pub, "Going well."]]);
  move("switching");
  assert.equal(await send(mini.peer, {}), fromLead);
  // Its copy there held until it's switched to: what comes from there isn't from it yet.
  move("copying");
  assert.equal(await send(mini.peer, listed), fromSomeone("mini"));
});

test("an allow goes only as far as the lead could go itself, never past this box's Don't Allow rules, and one kept over a day isn't given", async () => {
  eng.seen.asks.set("ses_billing", [
    { id: "per_1", action: "shell", resources: ["git status"] },
    { id: "per_2", action: "shell", resources: ["git push origin main"] },
  ]);
  const allow = (ask, as, extra = {}) => callOf("answer_ask", { session: "ses_billing", ask, decision: "allow", reason: "Needed." }, { as: { name: "Foreman", bot: by, free: true, rules: [], ...as }, ...extra });
  const words = async call => {
    await take(call);
    return answerOf(call).note.words;
  };
  // Its own conversation asks before commands, where it lives: so it can't let its session.
  assert.match(await words(allow("per_1", { rules: [{ action: "shell", resource: "*", effect: "ask" }] })), /^You can't allow that/);
  // Its own commands run in the sandbox there, and the session's don't here: not past that either.
  assert.match(await words(allow("per_1", { free: false })), /^You can't allow that/);
  // This box doesn't allow a push at all: a lead elsewhere doesn't get past that.
  write(path.join(home, "box", "opencode.json"), { permissions: [{ action: "shell", resource: "git push*", effect: "deny" }] });
  assert.match(await words(allow("per_2", {})), /^You can't allow that/);
  // Kept over a day while this box was away: not given; what it was for may have changed.
  assert.match(await words(allow("per_1", {}, { made: Date.now() - DAY - MINUTE })), /^Your allow for "Billing" wasn't given: this computer was away for over a day/);
  assert.equal(eng.seen.replied.length, 0);
  // Within all that: given, and a no is always the lead's to say.
  assert.equal(await words(allow("per_1", {})), "Allowed: git status.");
  const deny = callOf("answer_ask", { session: "ses_billing", ask: "per_2", decision: "deny", reason: "Not to main." });
  assert.equal(await words(deny), "Denied: git push origin main. \"Billing\" is told why.");
  assert.deepEqual(eng.seen.replied.map(each => [each.ask, each.decision, each.message]), [["per_1", "once", undefined], ["per_2", "reject", "Foreman: Not to main."]]);
});

test("calls aren't counted as messages: a lead may stop and answer as often as it would here", async () => {
  for (let i = 0; i < 25; i++) assert.equal((await take(callOf("list_sessions")))[0].ok, true, `call ${i + 1}`);
  const rows = JSON.parse(read(path.join(run, "outbox", "sending", sending().at(-1))).text).rows;
  assert.deepEqual(rows.map(row => row.session).sort(), ["ses_billing", "ses_left"]);
});

test("rows of a lead's sessions go to the computer it lives on, and only there, until that computer has them", async () => {
  write(path.join(run, "moves", "moved.json"), [{ session: "ses_lead", key: mini.pub, at: Date.now() - MINUTE }]);
  const sent = [];
  const host = { send: bytes => sent.push(bytes) };
  const opened = (bytes, to) => {
    try { return JSON.parse(link.openOneWay(link.readFrame(bytes.subarray(17)).body, to.key, link.publicOf(here.key)).payload.toString("utf8")); } catch { return null; }
  };
  const T = Date.now();
  await link.pushRows(host, link.readLink(), [eng.target], T);
  assert.equal(sent.length, 1, "to mini alone: the third box isn't any lead's, and the Mac doesn't take them");
  const rows = opened(sent[0], mini).rows;
  assert.deepEqual(rows.leads.ses_lead.map(row => [row.session, row.title, row.state]).sort(), [["ses_billing", "Billing", "idle"], ["ses_left", "Sign-in", "idle"]]);
  // Not again within the minute; again after, until it says it has them; then not until they change.
  await link.pushRows(host, link.readLink(), [eng.target], T + 1000);
  assert.equal(sent.length, 1);
  await link.pushRows(host, link.readLink(), [eng.target], T + MINUTE + 1000, { force: true });
  assert.equal(sent.length, 2);
  link.peerMail(mini.peer, { delivered: { id: rows.id, ok: true } }, host);
  // A quiet box stays quiet: minutes on, each round looking and working them out again, no mail at all.
  for (let at = T + 2 * MINUTE; at <= T + 5 * MINUTE; at += 3000) await link.pushRows(host, link.readLink(), [eng.target], at);
  assert.equal(sent.length, 2);
  // One's put away: they've changed, and go at once.
  eng.all.get("ses_billing").metadata.kuvo.archived = true;
  await link.pushRows(host, link.readLink(), [eng.target], T + 5 * MINUTE + 1000, { force: true });
  assert.deepEqual(opened(sent[2], mini).rows.leads.ses_lead.map(row => row.session), ["ses_left"]);
  // A busy box: another change a moment later waits for 15 seconds after the last, then goes.
  eng.all.get("ses_billing").metadata.kuvo.archived = false;
  await link.pushRows(host, link.readLink(), [eng.target], T + 5 * MINUTE + 4000, { force: true });
  await link.pushRows(host, link.readLink(), [eng.target], T + 5 * MINUTE + 7000);
  assert.equal(sent.length, 3, "no sooner than 15 s after the last");
  await link.pushRows(host, link.readLink(), [eng.target], T + 5 * MINUTE + 16_000);
  assert.equal(sent.length, 4, "worked out again each round until it may go");
  assert.equal(opened(sent[3], mini).rows.leads.ses_lead.length, 2);
  link.peerMail(mini.peer, { delivered: { id: opened(sent[3], mini).rows.id, ok: true } }, host);
  // None left: the lead's computer hears that once.
  eng.all.get("ses_left").metadata.kuvo.archived = true;
  eng.all.get("ses_billing").metadata.kuvo.archived = true;
  await link.pushRows(host, link.readLink(), [eng.target], T + 7 * MINUTE, { force: true });
  assert.deepEqual(opened(sent[4], mini).rows.leads, {});
  link.peerMail(mini.peer, { delivered: { id: opened(sent[4], mini).rows.id, ok: true } }, host);
  await link.pushRows(host, link.readLink(), [eng.target], T + 9 * MINUTE, { force: true });
  assert.equal(sent.length, 5);
});

test("rows kept from another computer: the newest it said, and the sessions it names live there", async () => {
  const row = (session, state) => ({ session, title: "Sign-in", folder: "/work", startedBy: "ses_lead", depth: 1, state, started: 1, tokens: 0 });
  assert.equal(link.takeRows(mini.peer, { at: 2000, leads: { ses_lead: [row("ses_far", "working")] } }), true);
  assert.equal(link.takeRows(mini.peer, { at: 1000, leads: { ses_lead: [row("ses_far", "finished")] } }), true, "older than what it said: had (so it isn't sent again), not kept");
  assert.equal(read(path.join(run, "work", "elsewhere", `${mini.pub}.json`)).leads.ses_lead[0].state, "working");
  assert.equal(read(path.join(run, "work", "homes.json")).ses_far.key, mini.pub);
  // Something that isn't a row is left out; a name, cleaned.
  link.takeRows(mini.peer, { at: 3000, leads: { ses_lead: [row("ses_far", "exploded"), { ...row("ses_two", "idle"), title: "Two‮ lines\nhere" }] } });
  assert.deepEqual(read(path.join(run, "work", "elsewhere", `${mini.pub}.json`)).leads.ses_lead.map(each => [each.session, each.title]), [["ses_two", "Two lines here"]]);
});

test("calls kept for a box that's away: the oldest goes each minute; an allow is let go after a day and the lead hears; a stop refused there for good is told", async () => {
  eng.all.set("ses_lead", { id: "ses_lead", title: "Foreman" });
  const T = Date.now();
  const keep = (id, call, at, extra = {}) => write(path.join(run, "outbox", "sending", `${id}.json`), { call: { as: { name: "Foreman", rules: [], free: true }, ...call }, from: "ses_lead", to: "", peer: mini.pub, at, wait: false, ...extra });
  keep("cal_kept000000000001", { tool: "stop_session", args: { session: "ses_a" } }, T - 3 * MINUTE);
  keep("cal_kept000000000002", { tool: "stop_session", args: { session: "ses_b" } }, T - 2 * MINUTE);
  keep("cal_kept000000000003", { tool: "compact_session", args: { session: "ses_c" } }, T - MINUTE);
  write(path.join(run, "peer-reach.json"), { [mini.pub]: T - 5 * MINUTE });
  const callsIn = sent => sent.map(bytes => {
    try { return JSON.parse(link.openOneWay(link.readFrame(bytes.subarray(17)).body, mini.key, link.publicOf(here.key)).payload.toString("utf8")).call; } catch { return null; }
  }).filter(Boolean);
  const round = async now => {
    const sent = [];
    await link.sendOutbox({ send: bytes => sent.push(bytes) }, link.readLink(), now, 0, undefined, 1);
    return callsIn(sent);
  };
  assert.deepEqual((await round(T)).map(each => each.args.session), ["ses_a"], "one, the oldest, while it isn't answering");
  assert.deepEqual((await round(T + 1000)).map(each => each.args.session), [], "and not each round");
  const again = await round(T + MINUTE + 1);
  assert.deepEqual(again.map(each => each.args.session), ["ses_a"], "the oldest again, a minute on");
  assert.equal(again[0].at, T + MINUTE + 1, "sealed at each send");
  assert.equal(again[0].made, T - 3 * MINUTE, "with when it was made beside that");
  // It's back (its mail comes): what's kept for it goes at once.
  link.peerMail(mini.peer, { agents: { at: T, list: [] } }, { send() {} });
  link.receiveMail(link.sealOneWay(Buffer.from(JSON.stringify({ at: T })), mini.key, link.publicOf(here.key)).message, { send() {} });
  assert.deepEqual(link.readReach(), {});
  assert.deepEqual((await round(T + MINUTE + 2)).map(each => each.args.session), ["ses_a", "ses_b", "ses_c"]);

  // An allow kept a day: let go, and the lead hears it wasn't given.
  keep("cal_kept000000000004", { tool: "answer_ask", args: { session: "ses_a", ask: "per_1", decision: "allow", reason: "Fine." } }, T - DAY - MINUTE);
  await round(T + 3 * MINUTE);
  assert.ok(!sending().includes("cal_kept000000000004.json"));
  const told = eng.seen.prompts.find(each => each.to === "ses_lead");
  assert.match(told.text, /^\[Not done\] Your answer_ask for ses_a on mini wasn't done: that computer wasn't back in time\. An allow waits a day at most/);

  // A kept stop whose box wasn't back in 30 days: let go, and the lead hears it wasn't done.
  keep("cal_kept000000000006", { tool: "stop_session", args: { session: "ses_d" } }, T - 30 * DAY - MINUTE);
  await round(T + 3 * MINUTE + 1);
  assert.ok(!sending().includes("cal_kept000000000006.json"));
  assert.match(eng.seen.prompts.filter(each => each.to === "ses_lead")[1].text, /^\[Not done\] Your stop_session for ses_d on mini wasn't done: that computer wasn't back in time\.$/);

  // A kept stop that box refuses for good (no such session there): the lead hears why.
  link.letterWent(mini.peer, { id: "cal_kept000000000001", ok: false, why: "There's no session ses_a on this computer." });
  // (Told as it's let go, from the receipt: looked at until it's there.)
  const refused = await arrives(() => eng.seen.prompts.filter(each => each.to === "ses_lead")[2]);
  assert.equal(refused.text, "[Not done] Your stop_session for ses_a on mini: There's no session ses_a on this computer.");
  // One sent to every box in case it's there (`quiet`) ends without a word.
  keep("cal_kept000000000005", { tool: "stop_session", args: { session: "ses_x" } }, T, { quiet: true, sentTo: mini.pub });
  link.letterWent(mini.peer, { id: "cal_kept000000000005", ok: false, why: "There's no session ses_x on this computer." });
  assert.ok(!sending().includes("cal_kept000000000005.json"));
  assert.equal(eng.seen.prompts.filter(each => each.to === "ses_lead").length, 3);
});

test("a message from another computer to a conversation this box doesn't list reaches it only from the conversation it's under", async () => {
  // What this box tells its peers: its bots and latest sessions, not the older Sign-in.
  write(path.join(run, "agents.json"), { machine: "devbox", agents: [{ session: "ses_user", name: "The user's own", kind: "session", machine: "devbox" }] });
  const letter = (from, to) => ({ id: "ltr_" + crypto.randomBytes(6).toString("hex"), from, to, text: "How's it going?", wait: false, at: Date.now() });
  const send = async (from, to) => {
    const said = [];
    await link.takeLetter(mini.peer, letter(from, to), { send: (_to, message) => said.push(message.delivered), targets: [eng.target], peers: [mini.peer], told: {}, moved: new Map(), wait: 1 });
    return said[0];
  };
  // The lead following up the session it started: there.
  assert.equal((await send("ses_lead", "ses_left")).ok, true);
  // Another conversation by its address: refused.
  const refused = await send("ses_someone", "ses_left");
  assert.deepEqual([refused.ok, refused.retry, refused.why], [false, undefined, "That conversation isn't one this computer lists, nor one you started: write to one that list_agents names."]);
  // One it lists takes anyone's, as before.
  assert.equal((await send("ses_someone", "ses_user")).ok, true);
  assert.deepEqual(eng.seen.prompts.map(each => each.to), ["ses_left", "ses_user"]);
});

test("a full list in any script comes back whole: never cut where the mail cuts a letter", async () => {
  // Forty sessions with long titles in Japanese, three bytes a character, and long last replies.
  const long = "署名の流れを直す作業".repeat(20);
  for (let i = 0; i < 40; i++) eng.all.set(`ses_jp${i}`, { id: `ses_jp${i}`, title: long, time: { created: i, updated: i }, directory: "/work", metadata: { kuvo: { startedBy: "ses_lead", depth: 1, by } } });
  const call = callOf("list_sessions");
  await take(call);
  const text = answerOf(call).text;
  assert.ok(Buffer.byteLength(text) <= 24_000, `${Buffer.byteLength(text)} bytes`);
  const rows = JSON.parse(text).rows;
  assert.ok(rows.length >= 5, `${rows.length} rows`);
  assert.equal(rows[0].title, long.slice(0, 200));
});

test("a lead's rules past what a call carries go as one that asks about everything: no allow past one left out", async () => {
  const many = Array.from({ length: 301 }, (_, i) => ({ action: "read", resource: `file${i}`, effect: "allow" }));
  const as = link.callAs({ session: "ses_lead", name: "Foreman", bot: by, rules: [...many, { action: "shell", resource: "*", effect: "deny" }], free: true });
  assert.deepEqual(as.rules, [{ action: "*", resource: "*", effect: "ask" }]);
  eng.seen.asks.set("ses_billing", [{ id: "per_1", action: "shell", resources: ["git status"] }]);
  const call = callOf("answer_ask", { session: "ses_billing", ask: "per_1", decision: "allow", reason: "Needed." }, { as });
  await take(call);
  assert.match(answerOf(call).note.words, /^You can't allow that/);
  assert.equal(eng.seen.replied.length, 0);
});

test("a call kept for a box that's away ends once its lead has moved on to another computer, and the lead hears it there", async () => {
  const T = Date.now();
  write(path.join(run, "outbox", "sending", "cal_moved00000000001.json"), { call: { tool: "stop_session", args: { session: "ses_a" }, as: { name: "Foreman", rules: [], free: true } }, from: "ses_lead", to: "", peer: mini.pub, at: T - MINUTE, wait: false });
  // The lead moved from this box to the third since.
  write(path.join(run, "moves", "moved.json"), [{ session: "ses_lead", key: third.pub, at: T - 1000 }]);
  const sent = [];
  await link.sendOutbox({ send: bytes => sent.push(bytes) }, link.readLink(), T, 0, undefined, 1);
  assert.ok(!sending().includes("cal_moved00000000001.json"), "it doesn't go to mini");
  // It's told on the computer the lead lives on now, as this box's own word.
  const told = sending().map(name => read(path.join(run, "outbox", "sending", name))).find(each => each?.to === "ses_lead");
  assert.equal(told.peer, third.pub);
  assert.equal(told.text, "[Not done] Your stop_session for ses_a wasn't done: you moved to another computer before it could go. Ask again from there.");
});

test("rows don't go to a computer that isn't answering: what changed goes once it's back", async () => {
  write(path.join(run, "moves", "moved.json"), [{ session: "ses_lead", key: mini.pub, at: Date.now() - MINUTE }]);
  write(path.join(run, "peer-reach.json"), { [mini.pub]: Date.now() - MINUTE });
  const sent = [];
  const host = { send: bytes => sent.push(bytes) };
  const T = Date.now();
  for (let at = T; at <= T + 10 * MINUTE; at += MINUTE) await link.pushRows(host, link.readLink(), [eng.target], at, { force: true });
  assert.equal(sent.length, 0, "ten minutes away, no mail");
  // Its mail comes: it's back, and the rows go at the next round.
  link.receiveMail(link.sealOneWay(Buffer.from(JSON.stringify({ at: T })), mini.key, link.publicOf(here.key)).message, host);
  await link.pushRows(host, link.readLink(), [eng.target], T + 10 * MINUTE + 3000);
  assert.equal(sent.length, 1);
});

// What an allow for a session on this box must pass: the lead's rules and this box's own, each on its own.
const allowing = (session, ask, as = {}) => callOf("answer_ask", { session, ask, decision: "allow", reason: "Needed." }, { as: { name: "Foreman", bot: by, free: true, rules: [], ...as } });
const sayOf = async call => {
  await take(call);
  return answerOf(call).note.words;
};
const boxRules = permissions => write(path.join(home, "box", "opencode.json"), { permissions });
const STATUS = { id: "per_1", action: "shell", resources: ["git status"] };

test("a session in Ask First is the user's to answer, whatever the lead's mode: the lead can't allow it from another computer, but may deny it", async () => {
  eng.all.set("ses_careful", { id: "ses_careful", time: { created: 1, updated: 1 }, directory: "/work", ...left("Careful", {}, "askFirst") });
  eng.seen.asks.set("ses_careful", [STATUS, { id: "per_2", action: "shell", resources: ["git log"] }]);
  assert.match(await sayOf(allowing("ses_careful", "per_1")), /^You can't allow that: "Careful" is in Ask First/);
  assert.deepEqual(eng.seen.replied, []);
  // The lead's no still goes.
  assert.equal(await sayOf(callOf("answer_ask", { session: "ses_careful", ask: "per_2", decision: "deny", reason: "No." })), "Denied: git log. \"Careful\" is told why.");
  assert.deepEqual(eng.seen.replied.map(each => [each.ask, each.decision]), [["per_2", "reject"]]);
  // The same, in Accept Edits: given.
  eng.seen.asks.set("ses_billing", [STATUS]);
  assert.equal(await sayOf(allowing("ses_billing", "per_1")), "Allowed: git status.");
});

test("this box's own Ask rules stop an allow from another computer too, not only its Don't Allow: moving a bot never loosens it", async () => {
  eng.seen.asks.set("ses_billing", [STATUS, { id: "per_2", action: "shell", resources: ["git push origin main"] }]);
  // This box asks before a command it names: the lead's rules (none) don't change that.
  boxRules([{ action: "shell", resource: "git status", effect: "ask" }]);
  assert.match(await sayOf(allowing("ses_billing", "per_1")), /^You can't allow that: you'd have to ask the user/);
  // A Don't Allow, as before.
  boxRules([{ action: "shell", resource: "git push*", effect: "deny" }]);
  assert.match(await sayOf(allowing("ses_billing", "per_2")), /^You can't allow that: you'd have to ask the user/);
  assert.deepEqual(eng.seen.replied, []);
  // Asking about everything but `git status`, which it allows: that one passes, and the rest doesn't.
  boxRules([{ action: "shell", resource: "*", effect: "ask" }, { action: "shell", resource: "git status", effect: "allow" }]);
  assert.equal(await sayOf(allowing("ses_billing", "per_1")), "Allowed: git status.");
  assert.match(await sayOf(allowing("ses_billing", "per_2")), /^You can't allow that/);
  assert.deepEqual(eng.seen.replied.map(each => each.ask), ["per_1"]);
});

test("this box allowing something doesn't undo the lead's own Ask: each is judged on its own", async () => {
  eng.seen.asks.set("ses_billing", [STATUS]);
  boxRules([{ action: "shell", resource: "*", effect: "allow" }]);
  assert.match(await sayOf(allowing("ses_billing", "per_1", { rules: [{ action: "shell", resource: "*", effect: "ask" }] })), /^You can't allow that: you'd have to ask the user/);
  // The lead asks about everything but `git status`, and this box allows it too: given.
  assert.equal(await sayOf(allowing("ses_billing", "per_1", { rules: [{ action: "shell", resource: "*", effect: "ask" }, { action: "shell", resource: "git status", effect: "allow" }] })), "Allowed: git status.");
  assert.deepEqual(eng.seen.replied.map(each => each.ask), ["per_1"]);
});

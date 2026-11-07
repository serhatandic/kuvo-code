// What a box takes of another box's calls for the sessions a lead left on it, and from whom
// (PROTOCOL.md, "Peers", `call`; design section 6): only from your own computers; only for a lead
// that isn't one of its own, nor known to live on another computer; only that lead's sessions; an
// allow only as far as the lead could go itself and never past this box's Don't Allow rules; and
// nothing a call can't reach. A call sent again is run once and answered once, and calls aren't
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
  const seen = { prompts: [], interrupted: [], replied: [], asks: new Map() };
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
      if (rest === "/message") return reply([]);
      reply({});
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  atEnd(() => { server.closeAllConnections(); server.close(); });
  return { seen, all, target: { port: server.address().port, password: "pw" } };
}

const by = { bot: "bot_foreman0001", name: "Foreman" };
const left = (title, extra = {}) => ({ title, metadata: { kuvo: { startedBy: "ses_lead", depth: 1, by } }, ...extra });
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
  await link.pushRows(host, link.readLink(), [eng.target], T + 3 * MINUTE, { force: true });
  assert.equal(sent.length, 2);
  // One's put away: they've changed, and go at once.
  eng.all.get("ses_billing").metadata.kuvo.archived = true;
  await link.pushRows(host, link.readLink(), [eng.target], T + 3 * MINUTE + 1000, { force: true });
  assert.deepEqual(opened(sent[2], mini).rows.leads.ses_lead.map(row => row.session), ["ses_left"]);
  link.peerMail(mini.peer, { delivered: { id: opened(sent[2], mini).rows.id, ok: true } }, host);
  // None left: the lead's computer hears that once.
  eng.all.get("ses_left").metadata.kuvo.archived = true;
  await link.pushRows(host, link.readLink(), [eng.target], T + 4 * MINUTE, { force: true });
  assert.deepEqual(opened(sent[3], mini).rows.leads, {});
  link.peerMail(mini.peer, { delivered: { id: opened(sent[3], mini).rows.id, ok: true } }, host);
  await link.pushRows(host, link.readLink(), [eng.target], T + 6 * MINUTE, { force: true });
  assert.equal(sent.length, 4);
});

test("rows kept from another computer: the newest it said, and the sessions it names live there", async () => {
  const row = (session, state) => ({ session, title: "Sign-in", folder: "/work", startedBy: "ses_lead", depth: 1, state, started: 1, tokens: 0 });
  assert.equal(link.takeRows(mini.peer, { at: 2000, leads: { ses_lead: [row("ses_far", "working")] } }), true);
  assert.equal(link.takeRows(mini.peer, { at: 1000, leads: { ses_lead: [row("ses_far", "finished")] } }), false, "older than what it said: not taken");
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

  // A kept stop that box refuses for good (no such session there): the lead hears why.
  link.letterWent(mini.peer, { id: "cal_kept000000000001", ok: false, why: "There's no session ses_a on this computer." });
  // (Told as it's let go, from the receipt: looked at until it's there.)
  const refused = await arrives(() => eng.seen.prompts.filter(each => each.to === "ses_lead")[1]);
  assert.equal(refused.text, "[Not done] Your stop_session for ses_a on mini: There's no session ses_a on this computer.");
  // One sent to every box in case it's there (`quiet`) ends without a word.
  keep("cal_kept000000000005", { tool: "stop_session", args: { session: "ses_x" } }, T, { quiet: true, sentTo: mini.pub });
  link.letterWent(mini.peer, { id: "cal_kept000000000005", ok: false, why: "There's no session ses_x on this computer." });
  assert.ok(!sending().includes("cal_kept000000000005.json"));
  assert.equal(eng.seen.prompts.filter(each => each.to === "ses_lead").length, 2);
});

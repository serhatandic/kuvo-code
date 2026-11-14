// News from a session always reaches whoever started it (PROTOCOL.md, "Peers", `note`, and "Work"):
// its lead may have moved to another computer, days ago, and that computer may be away for days.
// What it took to tell it goes as a note, kept until the lead has it, and it arrives once.
//
// Days pass here on a given clock, so it all runs in one process: this box is the real link, and
// the box the lead lives on takes each mail with the real `takeLetter`, over an engine of its own.
// The engines are stand-ins; a mail "lost" on the way is one the test doesn't hand on.
//
// Run with `node --test box/bridge-tests/news-arrives.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { atEnd, removeAtEnd } from "./at-end.js";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-news-arrives-")));
process.env.KUVO_HOME = home;
removeAtEnd(home);
const link = await import("../../swift/KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js");

const DAY = 86_400_000, MINUTE = 60_000;
const T = Date.now();
const run = path.join(home, "run");
const k = key => key.toString("base64url");
const box = (kind, id) => {
  const key = link.newKey();
  const address = k(link.addressOf(crypto.randomBytes(32)));
  return { key, pub: k(link.publicOf(key)), address, peer: { key: k(link.publicOf(key)), address, name: id ?? kind, kind, ...(id ? { id } : {}) } };
};
const here = box("machine", "devbox"), mac = box("mac");

// A computer of its own for each test: this box, a lead's box and a third.
function computers() {
  const lead = box("machine", "mini"), third = box("machine", "third");
  fs.rmSync(run, { recursive: true, force: true });
  fs.mkdirSync(run, { recursive: true });
  link.writeLink({ secret: crypto.randomBytes(32).toString("base64url"), key: k(here.key), relay: "wss://relay.test", name: "devbox", id: "devbox", mac: mac.pub, macs: [mac.pub], phones: [],
    legacy: { [mac.pub]: { at: 1, peers: [mac.peer, lead.peer, third.peer], moved: [] } } });
  return { lead, third };
}
const movedFrom = (entries) => {
  fs.mkdirSync(path.join(run, "moves"), { recursive: true });
  fs.writeFileSync(path.join(run, "moves", "moved.json"), JSON.stringify(entries));
};

// An engine with these sessions; what it was given to deliver is in `prompts`.
async function engine(sessions = {}) {
  const prompts = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      const reply = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      if (request.url.startsWith("/api/session?")) return reply({ data: Object.values(sessions) });
      if (request.url === "/api/session/active") return reply({ data: {} });
      if (/\/(permission|form)$/.test(request.url)) return reply({ data: [] });
      const one = request.url.match(/^\/api\/session\/([^/?]+)(\/[^?]*)?/);
      const id = one && decodeURIComponent(one[1]);
      if (one && !one[2]) return sessions[id] ? reply({ data: sessions[id] }) : reply({ message: "No such session." }, 404);
      if (one?.[2] === "/message") return reply({ data: [{ id: "msg_9", type: "assistant", content: [{ type: "text", text: "Sign-in works." }] }] });
      if (one?.[2] === "/prompt") {
        prompts.push({ to: id, ...JSON.parse(body) });
        return reply({});
      }
      reply({ message: "Not here." }, 404);
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  atEnd(() => { server.closeAllConnections(); server.close(); });
  return { prompts, target: { port: server.address().port, password: "pw" } };
}

const leftBehind = { ses_left: { id: "ses_left", title: "Sign-in", location: { directory: "/work/tidepool" }, time: { created: T - DAY, updated: 1 }, metadata: { kuvo: { startedBy: "ses_lead", depth: 1, wake: ["finished", "asks"] } } } };

// One round of this box's outbox, at `now`: the mail it sent.
async function round(now) {
  const sent = [];
  await link.sendOutbox({ send: bytes => sent.push(bytes) }, link.readLink(), now, 0, undefined, 1);
  return sent;
}
// What a mail says, as `to` opens it (a mail for another box isn't opened: null).
function openedBy(bytes, to) {
  const body = link.readFrame(bytes.subarray(17)).body;
  try {
    return JSON.parse(link.openOneWay(body, to.key, link.publicOf(here.key)).payload.toString("utf8"));
  } catch {
    return null;
  }
}
const lettersFor = (sent, to) => sent.map(bytes => openedBy(bytes, to)?.letter).filter(Boolean);

// A letter taken by the box a lead lives on, over its engine: how it answers.
async function taken(letter, target, now, extra = {}) {
  const said = [];
  await link.takeLetter(here.peer, letter, { send: (_to, message) => said.push(message.delivered), targets: [target], peers: [here.peer], told: {}, moved: new Map(), now, wait: 1, ...extra });
  return said[0];
}

// The coding agents' bridge running, as this box's real `peerPlaces` reads it: a process its record
// names, whose command line says it's the bridge, over an engine-like stand-in with no sessions.
const bridgeProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)", "kuvo-agents"], { stdio: "ignore" });
atEnd(() => bridgeProcess.kill());
async function bridgeUp() {
  const bridge = await engine({});
  fs.writeFileSync(path.join(run, "bridge.json"), JSON.stringify({ ...bridge.target, pid: bridgeProcess.pid }));
}
const engineUp = source => fs.writeFileSync(path.join(run, "engine.json"), JSON.stringify(source.target));

const waitingNotes = () => {
  try { return fs.readdirSync(path.join(run, "outbox", "sending")).filter(name => name.endsWith(".json")); } catch { return []; }
};
const leaveNote = (id, peer, at, to = "ses_lead") => {
  fs.mkdirSync(path.join(run, "outbox", "sending"), { recursive: true });
  fs.writeFileSync(path.join(run, "outbox", "sending", `${id}.json`), JSON.stringify({ from: null, to, text: `[Session finished] ${id}`, peer, wait: false, at, note: { from: "Its sessions", words: "It finished.", line: "It finished.", delivery: "queue" } }));
};
const noteLetter = (extra = {}) => ({ id: "ltr_" + crypto.randomBytes(6).toString("hex"), from: null, to: "ses_lead", text: "[Session finished] \"Sign-in\" (address ses_left):\nDone.", wait: false, at: T, note: { from: "Its sessions", words: "It finished.", line: "It finished.", delivery: "queue" }, ...extra });
const finishedOf = prompts => prompts.filter(each => each.text.startsWith("[Session finished] \"Sign-in\""));

// What makes the news: the real watcher, on the session left behind here.
async function sessionFinishes(source, at, session = "ses_left") {
  const later = [];
  const watch = link.workWatcher(source.target, () => [source.target], { schedule: run => { later.push(run); }, now: () => at, bridgeRuns: () => true });
  await watch({ type: "session.execution.succeeded", data: { sessionID: session } });
  for (const run of later.splice(0)) await run();
}

test("a lead's box away for 3 days hears [Session finished] once it's back, once, though the first receipt is lost", async () => {
  const { lead } = computers();
  const start = T;
  // Moved an hour before the session finishes, as today's box already handles.
  movedFrom([{ session: "ses_lead", key: lead.pub, at: start - 60 * MINUTE }]);
  const source = await engine(leftBehind);
  const leadBox = await engine({ ses_lead: { id: "ses_lead", title: "Foreman" } });
  await sessionFinishes(source, start);

  // The lead's box is away: each try goes nowhere, all through three days.
  for (const after of [MINUTE, DAY, DAY + 2 * 60 * MINUTE, 2 * DAY + MINUTE, 3 * DAY - MINUTE]) {
    assert.equal(lettersFor(await round(start + after), lead).length, 1, `the news still goes ${after / MINUTE} minutes on`);
  }

  // It's back. The note arrives, sealed now, and its receipt is lost on the way.
  const back = start + 3 * DAY + MINUTE;
  const [letter] = lettersFor(await round(back), lead);
  assert.ok(letter, "it goes once more when the lead's box is back");
  assert.equal(letter.at, back, "sealed at this send, so the box it reaches takes it");
  assert.equal(letter.made, start, "with when it was made beside that");
  const lost = await taken(letter, leadBox.target, back);
  assert.deepEqual([lost.ok, lost.why], [true, undefined], "delivered");
  assert.equal(finishedOf(leadBox.prompts).length, 1);
  assert.equal(leadBox.prompts[0].to, "ses_lead");
  assert.match(leadBox.prompts[0].text, /\(address ses_left\)/);
  assert.equal(leadBox.prompts[0].metadata?.kuvo?.note?.from, "Its sessions", "as the box's own word");

  // So it comes again, and this time the receipt arrives.
  const [again] = lettersFor(await round(back + MINUTE), lead);
  assert.ok(again, "no receipt: it comes again");
  link.letterWent(lead.peer, await taken(again, leadBox.target, back + MINUTE), back + MINUTE);
  assert.equal(finishedOf(leadBox.prompts).length, 1, "the same news isn't delivered twice");
  assert.deepEqual(waitingNotes(), [], "and it's done");
  assert.equal((await round(back + 2 * MINUTE)).length, 0);
});

test("a bot that moved 3 days ago still hears of a session it left behind", async () => {
  const { lead } = computers();
  movedFrom([{ session: "ses_lead", key: lead.pub, at: T - 3 * DAY }]);
  const source = await engine(leftBehind);
  const leadBox = await engine({ ses_lead: { id: "ses_lead", title: "Foreman" } });
  await sessionFinishes(source, T);
  const [letter] = lettersFor(await round(T), lead);
  assert.ok(letter, "the move is older than two days, and the news still has somewhere to go");
  link.letterWent(lead.peer, await taken(letter, leadBox.target, T), T);
  assert.equal(finishedOf(leadBox.prompts).length, 1);
  assert.deepEqual(waitingNotes(), []);
});

test("what this box learned of a move stays once the record of it is rewritten without it, days on", async () => {
  const { lead, third } = computers();
  movedFrom([{ session: "ses_lead", key: lead.pub, at: T - 3 * DAY }]);
  await round(T - 3 * DAY + MINUTE);
  // Another move ending here rewrites the record, and only keeps two days of it.
  movedFrom([{ session: "ses_other", key: third.pub, at: T - MINUTE }]);
  const source = await engine(leftBehind);
  await sessionFinishes(source, T);
  assert.equal(lettersFor(await round(T), lead).length, 1);
});

test("an answer you gave after its tool stopped waiting reaches a lead that moved 3 days ago", async () => {
  const { lead } = computers();
  movedFrom([{ session: "ses_lead", key: lead.pub, at: T - 3 * DAY }]);
  fs.mkdirSync(path.join(run, "work"), { recursive: true });
  fs.writeFileSync(path.join(run, "work", "asks.json"), JSON.stringify({ asks: [{ id: "wask_1", action: "makeProject", session: "ses_lead", name: "Foreman", project: "tidepool", given: { name: "tidepool" }, at: T - DAY, late: true, answered: { answer: "allow", text: "Made tidepool.", isError: false, at: T - MINUTE } }] }));
  const source = await engine({});
  await link.workWatcher(source.target, () => [source.target], { schedule: () => {}, now: () => T, bridgeRuns: () => true }).caughtUp;
  const [letter] = lettersFor(await round(T), lead);
  assert.ok(letter, "your answer goes to where it lives");
  assert.equal(letter.text, "[The user answered] Made tidepool.");
  assert.equal(letter.note.from, "Your answer");
});

test("a note a day old is refused only if it's a replay: one sent now goes, and a plain message still fails at a day", async () => {
  const { lead } = computers();
  const leadBox = await engine({ ses_lead: { id: "ses_lead", title: "Foreman" } });
  leaveNote("ltr_news00", lead.pub, T - 25 * 60 * MINUTE);
  fs.mkdirSync(path.join(run, "outbox", "sending"), { recursive: true });
  fs.writeFileSync(path.join(run, "outbox", "sending", "ltr_plain0.json"), JSON.stringify({ from: null, to: "ses_lead", text: "Hi", peer: lead.pub, wait: false, at: T - 25 * 60 * MINUTE }));
  const letters = lettersFor(await round(T), lead);
  const note = letters.find(each => each.note), plain = letters.find(each => !each.note);
  assert.equal(note.at, T, "the note is sealed at this send");
  assert.equal(note.made, T - 25 * 60 * MINUTE);
  assert.equal(plain.at, T - 25 * 60 * MINUTE, "a plain message keeps the time it was left");
  assert.equal(plain.made, undefined);
  assert.equal((await taken(note, leadBox.target, T)).ok, true);
  const refused = await taken(plain, leadBox.target, T);
  assert.deepEqual([refused.ok, refused.why, refused.retry], [false, "It's too old to deliver.", undefined]);

  // A relay's replay of a note from days ago isn't delivered, and doesn't end the real one, which comes again.
  const replayed = await taken(noteLetter({ at: T - 3 * DAY }), leadBox.target, T);
  assert.deepEqual([replayed.ok, replayed.retry], [false, true]);
  assert.equal(leadBox.prompts.length, 1);
});

test("a note told to come again days on does; a plain message past two days doesn't, and either ends past its time", async () => {
  const { lead } = computers();
  leaveNote("ltr_news01", lead.pub, T - 3 * DAY);
  await round(T);
  link.letterWent(lead.peer, { id: "ltr_news01", ok: false, why: "It's archived: it comes again once it's brought back.", retry: true }, T);
  assert.deepEqual(waitingNotes(), ["ltr_news01.json"], "told to come again, three days on");
  assert.equal(lettersFor(await round(T + MINUTE), lead).length, 1);

  fs.writeFileSync(path.join(run, "outbox", "sending", "ltr_plain1.json"), JSON.stringify({ from: null, to: "ses_lead", text: "Hi", peer: lead.pub, wait: false, at: T - 3 * DAY }));
  await round(T + 2 * MINUTE);
  assert.deepEqual(waitingNotes(), ["ltr_news01.json"], "a plain message goes at two days, as it did");

  // Thirty days after it was made: it's let go of.
  await round(T - 3 * DAY + 30 * DAY + MINUTE);
  assert.deepEqual(waitingNotes(), []);
});

test("a note delivered once isn't delivered again three days later, whatever time it's sealed with", async () => {
  computers();
  const leadBox = await engine({ ses_lead: { id: "ses_lead", title: "Foreman" } });
  const letter = noteLetter();
  assert.equal((await taken(letter, leadBox.target, T)).ok, true);
  const later = await taken({ ...letter, at: T + 3 * DAY }, leadBox.target, T + 3 * DAY);
  assert.equal(later.ok, true, "it's there");
  assert.equal(leadBox.prompts.length, 1);
  const muchLater = await taken({ ...letter, at: T + 29 * DAY }, leadBox.target, T + 29 * DAY);
  assert.equal(muchLater.ok, true);
  assert.equal(leadBox.prompts.length, 1);
  // A plain letter's id is remembered for two days, as it was (it's only ever good for one).
  const plain = noteLetter({ note: undefined, from: "ses_there" });
  await taken(plain, leadBox.target, T);
  assert.equal(leadBox.prompts.length, 2);
});

test("a lead moved twice: the box it moved on from says where it lives, and the news goes on to it", async () => {
  const { lead, third } = computers();
  movedFrom([{ session: "ses_lead", key: lead.pub, at: T - 2 * MINUTE }]);
  const source = await engine({ ...leftBehind, ses_later: { ...leftBehind.ses_left, id: "ses_later", title: "Billing" } });
  const nowThere = await engine({ ses_lead: { id: "ses_lead", title: "Foreman" } });
  const middle = await engine({});
  await sessionFinishes(source, T);
  const [first] = lettersFor(await round(T), lead);
  const said = await taken(first, middle.target, T, { moved: new Map([["ses_lead", third.pub]]) });
  assert.deepEqual([said.ok, said.retry, said.lives], [false, true, third.pub]);
  link.letterWent(lead.peer, said, T);
  // (Only the box it was sent to has a say: another's word on it counts for nothing.)
  const [onward] = lettersFor(await round(T + MINUTE), third);
  assert.ok(onward, "it goes on to the computer it lives on now");
  link.letterWent(third.peer, await taken(onward, nowThere.target, T + MINUTE), T + MINUTE);
  assert.equal(finishedOf(nowThere.prompts).length, 1);
  assert.deepEqual(waitingNotes(), []);
  // And the next news goes straight there.
  await sessionFinishes(source, T + 2 * MINUTE, "ses_later");
  assert.equal(lettersFor(await round(T + 2 * MINUTE), third).length, 1);
});

test("a lead moved away and back again: the box it left says so, and it hears here", async () => {
  const { lead } = computers();
  const backHere = await engine({ ses_lead: { id: "ses_lead", title: "Foreman" } });
  fs.writeFileSync(path.join(run, "engine.json"), JSON.stringify({ port: backHere.target.port, password: "pw" }));
  leaveNote("ltr_news07", lead.pub, T);
  await round(T);
  link.letterWent(lead.peer, { id: "ltr_news07", ok: false, retry: true, lives: k(link.publicOf(here.key)) }, T);
  await round(T + MINUTE);
  assert.equal(backHere.prompts.length, 1);
  assert.deepEqual(waitingNotes(), []);
  fs.rmSync(path.join(run, "engine.json"), { force: true });
});

test("only the box a note went to can say where it lives now", async () => {
  const { lead, third } = computers();
  leaveNote("ltr_news02", lead.pub, T);
  await round(T);
  link.letterWent(third.peer, { id: "ltr_news02", ok: false, retry: true, lives: third.pub }, T);
  assert.equal(lettersFor(await round(T + MINUTE), lead).length, 1, "another box's word changes nothing");
  link.letterWent(lead.peer, { id: "ltr_news02", ok: false, retry: true, lives: "not-a-key" }, T);
  assert.equal(lettersFor(await round(T + 2 * MINUTE), lead).length, 1, "nor does something that isn't a box's key");
});

test("the box a lead moved on from more than two days ago still says where it went, and doesn't end the note", async () => {
  const { third } = computers();
  movedFrom([{ session: "ses_lead", key: third.pub, at: T - 3 * DAY }]);
  const middle = await engine({});
  const said = await taken(noteLetter(), middle.target, T);
  assert.deepEqual([said.ok, said.retry, said.lives], [false, true, third.pub]);
  // A plain message there is refused, as it was.
  const plain = await taken(noteLetter({ note: undefined }), middle.target, T);
  assert.deepEqual([plain.ok, plain.retry], [false, undefined]);
});

test("an older box that only says to come again: the note follows what that box's agents' mail says", async () => {
  const { lead, third } = computers();
  movedFrom([{ session: "ses_lead", key: lead.pub, at: T - 60 * MINUTE }]);
  leaveNote("ltr_news03", lead.pub, T);
  await round(T);
  link.letterWent(lead.peer, { id: "ltr_news03", ok: false, why: "It's moving to another computer: it comes again once it's there.", retry: true }, T);
  fs.writeFileSync(path.join(run, "peer-agents.json"), JSON.stringify({ [lead.pub]: { at: 2, heard: T, kind: "machine", list: [], moved: [{ session: "ses_lead", key: third.pub, at: T - MINUTE }] } }));
  assert.equal(lettersFor(await round(T + MINUTE), third).length, 1);
});

test("a lead back on this box hears here, whatever a home says", async () => {
  const { lead } = computers();
  movedFrom([{ session: "ses_lead", key: lead.pub, at: T - 3 * DAY }]);
  await round(T - 3 * DAY + MINUTE);
  const source = await engine({ ...leftBehind, ses_lead: { id: "ses_lead", title: "Foreman" } });
  await sessionFinishes(source, T);
  assert.equal(finishedOf(source.prompts).length, 1);
  assert.deepEqual(waitingNotes(), []);
});

test("a machine dropped from a list isn't given up on; one you removed is", async () => {
  const signer = (() => {
    const seed = link.newSigningSeed();
    const counts = {};
    return { key: link.signingKeyOf(seed), doc: (kind, body) => link.signDoc(seed, kind, (counts[kind] = (counts[kind] ?? 0) + 1), body) };
  })();
  const lead = box("machine", "mini"), third = box("machine", "third");
  fs.rmSync(run, { recursive: true, force: true });
  fs.mkdirSync(run, { recursive: true });
  const own = link.newSigningSeed();
  link.writeLink({ secret: crypto.randomBytes(32).toString("base64url"), key: k(here.key), relay: "wss://relay.test", name: "devbox", id: "devbox", mac: mac.pub, macs: [mac.pub], phones: [], sign: own, macSigns: { [mac.pub]: signer.key } });
  const named = (each, sign) => ({ ...each.peer, sign });
  const sender = { ...mac.peer, sign: signer.key };
  const me = { ...here.peer, sign: link.ownSign(link.readLink()) };
  const host = { send() {}, keepOnly() {} };
  const boxes = (...others) => [named(mac, signer.key), me, ...others.map(each => named(each, signer.key))];
  await link.receiveDocs(sender, { give: [signer.doc("peers", { boxes: boxes(lead, third), moved: [], left: [] })] }, host);
  assert.deepEqual(link.peersOf(link.readLink()).map(peer => peer.name).sort(), ["mac", "mini", "third"]);

  leaveNote("ltr_news04", lead.pub, T - 3 * DAY, "ses_lead");
  leaveNote("ltr_news05", third.pub, T - 3 * DAY, "ses_other");
  assert.equal((await round(T - 3 * DAY + MINUTE)).length, 2);

  // Each leaves the list. `mini` was only left out (it can't be reached to be set up, say): it
  // waits. `third` you removed.
  await link.receiveDocs(sender, { give: [signer.doc("peers", { boxes: boxes(), moved: [], left: [third.pub] })] }, host);
  assert.deepEqual(link.peersOf(link.readLink()).map(peer => peer.name), ["mac"]);
  assert.equal((await round(T - 2 * DAY)).length, 0);
  assert.deepEqual(waitingNotes(), ["ltr_news04.json"], "a removed machine's news has nowhere to go; the other waits");

  // Back on the list, days on: it goes.
  await link.receiveDocs(sender, { give: [signer.doc("peers", { boxes: boxes(lead), moved: [], left: [third.pub] })] }, host);
  assert.equal(lettersFor(await round(T), lead).length, 1);

  // One left for a removed box whose lead is listed here again: it's delivered here, not ended.
  const backHere = await engine({ ses_back: { id: "ses_back", title: "Back" } });
  engineUp(backHere);
  fs.writeFileSync(path.join(run, "agents.json"), JSON.stringify({ agents: [{ session: "ses_back", name: "Back" }] }));
  leaveNote("ltr_news12", third.pub, T, "ses_back");
  await round(T + MINUTE);
  assert.equal(backHere.prompts.filter(each => each.to === "ses_back").length, 1);
  assert.ok(!waitingNotes().includes("ltr_news12.json"));
});

test("a lead on a coding agent whose bridge is down: a note comes again however long that takes; a plain message is refused, as it was", async () => {
  computers();
  const leadBox = await engine({ ses_lead: { id: "ses_lead", title: "Foreman" } });
  const noBridge = await engine({});
  const note = noteLetter();
  for (const after of [0, 31 * MINUTE, 3 * 60 * MINUTE, 3 * DAY]) {
    const said = await taken({ ...note, at: T + after }, noBridge.target, T + after, { bridge: false });
    assert.deepEqual([said.ok, said.retry], [false, true], `${after / MINUTE} minutes on`);
  }
  assert.equal((await taken({ ...note, at: T + 3 * DAY }, leadBox.target, T + 3 * DAY, { bridge: true })).ok, true);
  assert.equal(leadBox.prompts.length, 1);

  const plain = noteLetter({ note: undefined });
  await taken(plain, noBridge.target, T, { bridge: false });
  const refused = await taken({ ...plain, at: T + 31 * MINUTE }, noBridge.target, T + 31 * MINUTE, { bridge: false });
  assert.deepEqual([refused.ok, refused.retry], [false, undefined]);
});

test("a conversation really gone there ends the note: its box says so, and asleep isn't that", async () => {
  const { lead } = computers();
  const empty = await engine({});
  leaveNote("ltr_news06", lead.pub, T);
  const [letter] = lettersFor(await round(T), lead);
  const said = await taken(letter, empty.target, T, { bridge: true });
  assert.deepEqual([said.ok, said.retry], [false, undefined]);
  link.letterWent(lead.peer, said, T);
  assert.deepEqual(waitingNotes(), []);
});

test("a box whose engine is starting again, its bridge up: news kept for it isn't told there's no such conversation, and arrives once the engine's up", async () => {
  const { lead } = computers();
  const leadBox = await engine({ ses_lead: { id: "ses_lead", title: "Foreman" } });
  await bridgeUp();
  // Its record isn't written until the engine's ready, so only the bridge can be asked.
  const said = await taken(noteLetter(), null, T, link.peerPlaces());
  assert.deepEqual([said.ok, said.retry], [false, true]);
  const plain = await taken(noteLetter({ note: undefined, from: "ses_there" }), null, T, link.peerPlaces());
  assert.deepEqual([plain.ok, plain.retry], [false, true], "nor is a message");
  link.letterWent(lead.peer, said, T);

  engineUp(leadBox);
  assert.equal(link.peerPlaces().bridge, true);
  assert.equal((await taken(noteLetter(), null, T, link.peerPlaces())).ok, true);
  assert.equal(leadBox.prompts.length, 1);
});

test("this box's engine starting again: a note for a lead back here waits, news kept for it stays, old addresses stay", async () => {
  computers();
  const source = await engine({ ...leftBehind, ses_lead: { id: "ses_lead", title: "Foreman" } });
  await bridgeUp();
  // A note for one that came back here.
  leaveNote("ltr_news10", k(link.publicOf(here.key)), T);
  await round(T);
  assert.deepEqual(waitingNotes(), ["ltr_news10.json"]);

  // The news of a session here, which only the engine could say a word on.
  const later = [];
  const watch = link.workWatcher(source.target, () => link.peerPlaces().targets, { schedule: each => { later.push(each); }, now: () => T });
  await watch({ type: "session.execution.succeeded", data: { sessionID: "ses_left" } });
  for (const each of later.splice(0)) await each();
  assert.equal(source.prompts.length, 0);

  // An address a month old, while the engine that may name it can't say.
  fs.writeFileSync(path.join(run, "work", "homes.json"), JSON.stringify({ ses_old: { key: here.peer.key, at: T - 40 * DAY } }));
  await link.forgetOldHomes(T);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(run, "work", "homes.json"), "utf8"))), ["ses_old"]);

  // The engine's up: both arrive.
  engineUp(source);
  await round(T + MINUTE);
  for (const each of later.splice(0)) await each();
  assert.deepEqual(source.prompts.map(each => each.text).filter(text => text.startsWith("[Session finished] ltr_news10")).length, 1);
  assert.equal(finishedOf(source.prompts).length, 1);
  assert.deepEqual(waitingNotes(), []);
});

test("a lead on a coding agent whose bridge is down: its news is kept here for days, and it hears once the bridge is back", async () => {
  computers();
  const source = await engine(leftBehind);
  const agentBridge = await engine({ ses_lead: { id: "ses_lead", title: "Foreman" } });
  let at = T, places = [source.target];
  const later = [];
  const watch = link.workWatcher(source.target, () => places, { schedule: each => { later.push(each); }, now: () => at, bridgeRuns: () => false });
  const drain = async () => { for (const each of later.splice(0)) await each(); };
  await watch({ type: "session.execution.succeeded", data: { sessionID: "ses_left" } });
  await drain();
  at = T + 3 * DAY;
  await drain();
  places = [source.target, agentBridge.target];
  at += MINUTE;
  await drain();
  assert.equal(finishedOf(agentBridge.prompts).length, 1);

  // As long as a note would be, and no longer.
  const otherWatch = link.workWatcher(source.target, () => [source.target], { schedule: each => { later.push(each); }, now: () => at, bridgeRuns: () => false });
  await otherWatch({ type: "session.execution.succeeded", data: { sessionID: "ses_left" } });
  await drain();
  at += 31 * DAY;
  await drain();
  places = [source.target, agentBridge.target];
  await drain();
  const wakes = JSON.parse(fs.readFileSync(path.join(run, "work", "wakes.json"), "utf8"));
  assert.equal(Object.keys(wakes.waiting ?? wakes).filter(key => key === "ses_lead").length, 0);
});

test("a note for a lead put away here waits until it's brought back; a plain message for it is refused, as it was", async () => {
  computers();
  const lead = { id: "ses_lead", title: "Foreman", metadata: { kuvo: { archived: true } } };
  const backHere = await engine({ ses_lead: lead });
  engineUp(backHere);
  leaveNote("ltr_news11", k(link.publicOf(here.key)), T);
  fs.mkdirSync(path.join(run, "outbox", "sending"), { recursive: true });
  await round(T);
  assert.deepEqual(waitingNotes(), ["ltr_news11.json"]);
  assert.equal(backHere.prompts.length, 0);
  delete lead.metadata;
  await round(T + MINUTE);
  assert.equal(backHere.prompts.length, 1);
  assert.deepEqual(waitingNotes(), []);
});

test("a box that keeps saying not now for one conversation: only that conversation's oldest goes each minute, and another's isn't held back", async () => {
  const { lead } = computers();
  for (let i = 0; i < 4; i++) leaveNote(`ltr_kept0${i}`, lead.pub, T + i);
  leaveNote("ltr_other", lead.pub, T + 9, "ses_other");
  const notNow = (id, at) => link.letterWent(lead.peer, { id, ok: false, why: "It's archived: it comes again once it's brought back.", retry: true }, at);
  for (const each of lettersFor(await round(T + 10), lead)) notNow(each.id, T + 20);
  for (const each of lettersFor(await round(T + MINUTE + 10), lead)) notNow(each.id, T + MINUTE + 20);
  const paced = lettersFor(await round(T + 3 * MINUTE), lead);
  assert.deepEqual(paced.map(each => each.id).sort(), ["ltr_kept00", "ltr_other"], "one each, however often it answers");
  // The other is delivered, and that conversation's next would go at once: this one stays paced.
  link.letterWent(lead.peer, { id: "ltr_other", ok: true }, T + 3 * MINUTE);
  notNow("ltr_kept00", T + 3 * MINUTE);
  assert.deepEqual(lettersFor(await round(T + 4 * MINUTE), lead).map(each => each.id), ["ltr_kept00"]);
  // It's brought back, and the rest follow.
  link.letterWent(lead.peer, { id: "ltr_kept00", ok: true }, T + 4 * MINUTE);
  assert.equal(lettersFor(await round(T + 5 * MINUTE), lead).length, 3);
});

test("what a kept note says of where a session lives is as old as the note: it doesn't undo fresher word", async () => {
  const { lead, third } = computers();
  const leadBox = await engine({ ses_lead: { id: "ses_lead", title: "Foreman" } });
  const homes = () => JSON.parse(fs.readFileSync(path.join(run, "work", "homes.json"), "utf8"));
  fs.mkdirSync(path.join(run, "work"), { recursive: true });
  fs.writeFileSync(path.join(run, "work", "homes.json"), JSON.stringify({ ses_left: { key: third.pub, at: T - DAY } }));
  const note = { from: "Its sessions", words: "It finished.", delivery: "queue" };
  const fromLead = (made, about) => link.takeLetter(lead.peer, noteLetter({ made, note: { ...note, about: [about] } }), { send() {}, targets: [leadBox.target], peers: [lead.peer], told: {}, moved: new Map(), now: T, wait: 1, moving: async () => false });
  await fromLead(T - 3 * DAY, "ses_left");
  assert.equal(homes().ses_left.key, third.pub, "a note made before that move was heard of");
  await fromLead(T - MINUTE, "ses_left");
  assert.equal(homes().ses_left.key, lead.pub, "one made since is news");
  await fromLead(T - 2 * DAY, "ses_new");
  assert.deepEqual(homes().ses_new, { key: lead.pub, at: T - 2 * DAY });
});

test("days of kept notes arriving don't hold up a plain message from that box", async () => {
  computers();
  const leadBox = await engine({ ses_lead: { id: "ses_lead", title: "Foreman" } });
  for (let i = 0; i < 20; i++) assert.equal((await taken(noteLetter(), leadBox.target, T)).ok, true);
  const more = await taken(noteLetter(), leadBox.target, T);
  assert.deepEqual([more.ok, more.retry], [false, true], "a box's notes still come a few at a time");
  const plain = await taken(noteLetter({ note: undefined, from: "ses_there", text: "Fresh." }), leadBox.target, T);
  assert.equal(plain.ok, true);
  assert.ok(leadBox.prompts.some(each => each.text.includes("Fresh.")));
});

test("what this box knows of homes isn't written again and again while nothing's new", async () => {
  const { lead } = computers();
  const file = path.join(run, "work", "homes.json");
  const mine = k(link.publicOf(here.key));
  movedFrom([{ session: "ses_went", key: lead.pub, at: T - 60 * MINUTE }]);
  await round(T);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).ses_went.key, lead.pub);
  // Away and back here again, as that box says, and it isn't listed here yet: its home goes, once.
  fs.writeFileSync(path.join(run, "peer-agents.json"), JSON.stringify({ [lead.pub]: { at: 2, heard: T, kind: "machine", list: [], moved: [{ session: "ses_went", key: mine, at: T - 30 * MINUTE }] } }));
  await round(T);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {});
  const written = fs.statSync(file).ino;
  await round(T + 3000);
  assert.equal(fs.statSync(file).ino, written);
});

test("many notes for a box that's away: only the oldest goes each minute until it answers, then the rest follow", async () => {
  const { lead } = computers();
  for (let i = 0; i < 5; i++) leaveNote(`ltr_many0${i}`, lead.pub, T + i);
  assert.equal(lettersFor(await round(T + 10), lead).length, 5, "it may just be a moment: they all go");
  assert.equal(lettersFor(await round(T + MINUTE + 10), lead).length, 5);
  const quiet = lettersFor(await round(T + 3 * MINUTE), lead);
  assert.deepEqual(quiet.map(each => each.id), ["ltr_many00"], "no word from it: one a minute");
  assert.equal(lettersFor(await round(T + 3 * MINUTE + 3000), lead).length, 0, "not each round");
  assert.deepEqual(lettersFor(await round(T + 4 * MINUTE + 3000), lead).map(each => each.id), ["ltr_many00"]);
  // It's back, and answers.
  link.letterWent(lead.peer, { id: "ltr_many00", ok: true }, T + 4 * MINUTE + 4000);
  assert.equal(lettersFor(await round(T + 5 * MINUTE + 3000), lead).length, 4, "the rest follow at once");
});

test("a note teaches this box where the sessions it speaks of live; an address goes when nothing here names it and 30 days have passed", async () => {
  const { lead } = computers();
  const leadBox = await engine({ ses_lead: { id: "ses_lead", title: "Foreman" }, ses_named: { id: "ses_named", title: "Still mine", metadata: { kuvo: { startedBy: "ses_kept" } } } });
  const homes = () => JSON.parse(fs.readFileSync(path.join(run, "work", "homes.json"), "utf8"));
  await link.takeLetter(lead.peer, noteLetter({ note: { from: "Its sessions", words: "It finished.", line: "It finished.", delivery: "queue", about: ["ses_left"] } }), { send() {}, targets: [leadBox.target], peers: [lead.peer], told: {}, moved: new Map(), now: T, wait: 1, moving: async () => false });
  assert.equal(homes().ses_left.key, lead.pub, "the session the note was about lives on the box that sent it");

  // Three kept, a month old, and one of those is still named by a session here.
  fs.writeFileSync(path.join(run, "work", "homes.json"), JSON.stringify({ ses_kept: { key: lead.pub, at: T - 40 * DAY }, ses_old: { key: lead.pub, at: T - 40 * DAY }, ses_new: { key: lead.pub, at: T - DAY } }));
  // While a place conversations run isn't there, nothing can be said of what's named: they stay.
  await link.forgetOldHomes(T, () => ({ targets: [leadBox.target], bridge: false }));
  assert.deepEqual(Object.keys(homes()).sort(), ["ses_kept", "ses_new", "ses_old"]);
  // (It looks once an hour: a round in an earlier test may just have.)
  await link.forgetOldHomes(T + 2 * 60 * MINUTE, () => ({ targets: [leadBox.target], bridge: true }));
  assert.deepEqual(Object.keys(homes()).sort(), ["ses_kept", "ses_new"]);
});

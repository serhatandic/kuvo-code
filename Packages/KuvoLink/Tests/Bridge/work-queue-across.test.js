// The Work Queue across your computers (PROTOCOL.md, "The Work Queue", "Across your computers"):
// one list for everything. What each computer tells the others of its queue shows in the All view
// and in a lead's view, with which computer it's on; chips and an item's page answer from it, and a
// change to one goes to that computer. Each box tells its own as it changes (in parts when it's too
// big for one mail). Numbers come from the first computer you set up, wherever a box hears of it.
// An item handed to a conversation on another computer moves once. And what a newer box keeps (an
// outside tracker's author, a queue of a kind this box doesn't know) is kept.
//
// One box (a machine, here, by the real link in this process), its Mac and another machine as keys
// whose mail is sealed and opened as the relay carries it; only the engine is a stand-in.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/work-queue-across.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { atEnd, removeAtEnd } from "./at-end.js";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-work-queue-across-")));
removeAtEnd(home);
// GitHub's `gh`, standing in: it says each time it's asked (`gh-asked`), and answers what a test
// says GitHub would (`gh-answer.json`), else that it's signed out. Never GitHub itself.
const ghAsked = path.join(home, "gh-asked"), ghAnswer = path.join(home, "gh-answer.json");
fs.mkdirSync(path.join(home, "bin"), { recursive: true });
fs.writeFileSync(path.join(home, "bin", "gh"), `#!/bin/sh\necho asked >> '${ghAsked}'\nif [ -f '${ghAnswer}' ]; then cat '${ghAnswer}'; exit 0; fi\necho 'gh auth login' >&2\nexit 1\n`, { mode: 0o755 });
const ghAsks = () => (fs.existsSync(ghAsked) ? fs.readFileSync(ghAsked, "utf8").split("\n").filter(Boolean).length : 0);
process.env.PATH = `${path.join(home, "bin")}${path.delimiter}${process.env.PATH}`;
process.env.KUVO_HOME = home;
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");
const run = path.join(home, "run");
const queues = path.join(run, "work-queue");
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
};
const read = file => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };

// The engine: a lead and the session it started, both here, and what each calls now.
const sessions = new Map([
  ["ses_lead", { id: "ses_lead", title: "Lead", time: { created: 1, updated: 5 } }],
  ["ses_child", { id: "ses_child", title: "Sign-in", metadata: { kuvo: { startedBy: "ses_lead", depth: 1 } }, time: { created: 2, updated: 6 } }],
]);
const calling = new Map();
const engine = http.createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    const reply = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    const url = new URL(request.url, "http://x");
    if (url.pathname === "/api/session" && request.method === "GET") return reply({ data: [...sessions.values()] });
    if (url.pathname === "/api/session/active") return reply({ data: {} });
    const one = url.pathname.match(/^\/api\/session\/([^/]+)(\/.*)?$/);
    const id = one && decodeURIComponent(one[1]);
    if (one && !one[2]) return sessions.has(id) ? reply({ data: sessions.get(id) }) : reply({ message: "No such session." }, 404);
    if (one?.[2] === "/message") {
      const call = calling.get(id);
      return reply({ data: call ? [{ id: "msg_1", type: "assistant", content: [{ type: "tool", name: `kuvo-browser_${call.name}`, callID: "call_1", state: { status: "running", input: call.args } }] }] : [] });
    }
    reply({ data: [] });
  });
});
await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
atEnd(() => { engine.closeAllConnections(); engine.close(); });
const target = { port: engine.address().port, password: "p" };
const targets = [target];
const places = () => ({ targets, bridge: true });

// This box (a machine, "devbox"), the Mac that set it up, a later Mac, and another machine ("lab").
const k = key => key.toString("base64url");
const box = (kind, name, id) => {
  const key = link.newKey();
  const address = k(link.addressOf(crypto.randomBytes(32)));
  return { key, pub: k(link.publicOf(key)), address, peer: { key: k(link.publicOf(key)), address, name, kind, ...(id ? { id } : {}) } };
};
const here = box("machine", "devbox", "devbox"), mac = box("mac", "Studio"), later = box("mac", "Laptop"), lab = box("machine", "lab", "lab");
const fresh = ({ macs = [mac], peers = [mac, lab, here] } = {}) => {
  link.writeLink({
    secret: crypto.randomBytes(32).toString("base64url"), key: k(here.key), relay: "wss://relay.test", name: "devbox", id: "devbox", mac: macs.at(-1).pub, macs: macs.map(each => each.pub), phones: [],
    // (Each Mac's list of its boxes, as a Mac that signs no documents gives it: who the peers are.)
    legacy: Object.fromEntries(macs.map(each => [each.pub, { at: 1, peers: [each.peer, ...peers.filter(peer => peer.peer.kind === "machine").map(peer => peer.peer)] }])),
  });
};
// What each peer's agents' mail said: their agents, and that they take the Work Queue's mail.
const agentsTold = (extra = {}) => write(path.join(run, "peer-agents.json"), {
  [lab.pub]: { at: 1, heard: Date.now(), kind: "machine", id: "lab", list: [{ session: "ses_far", name: "Far", kind: "session" }, { session: "ses_wren", name: "Wren", kind: "bot" }], features: ["work-queue", "work-queue.elsewhere"] },
  [mac.pub]: { at: 1, heard: Date.now(), kind: "mac", list: [], features: ["work-queue", "work-queue.elsewhere"] },
  ...extra,
});

// Mail as the relay hands it on, from `from` to this box; and what this box sent, opened as `to` would.
const mailFrom = (from, payload) => link.sealOneWay(Buffer.from(JSON.stringify({ ...payload, at: Date.now() })), from.key, link.publicOf(here.key)).message;
const opened = (bytes, to) => {
  const body = link.readFrame(bytes.subarray(17)).body;
  return { address: k(bytes.subarray(1, 17)), payload: JSON.parse(link.openOneWay(body, to.key, link.publicOf(here.key)).payload.toString("utf8")) };
};
// A relay connection that keeps what's sent; and mail taken as this box's link takes it.
const sent = [];
const host = { welcomed: true, send: bytes => sent.push(bytes) };
const receive = (from, payload) => link.receiveMail(mailFrom(from, payload), host, (sender, given) => link.peerMail(sender, given, host, places));
// Mail a computer's link takes as it comes, waited on until it's done with (a hand-off looks up
// its conversation first).
const takeFrom = (from, workQueue) => link.takeWorkQueueMail(from.peer, workQueue, host, places);
const mailTo = to => {
  const theirs = sent.filter(bytes => k(bytes.subarray(1, 17)) === to.address);
  for (const bytes of theirs) sent.splice(sent.indexOf(bytes), 1);
  return theirs.map(bytes => opened(bytes, to).payload);
};

// The box's answer to one request, from a client (this Mac's app).
const handle = link.engineHandler(() => target);
async function route(method, pathname, body) {
  const pieces = [];
  for await (const piece of handle({ method, path: pathname, headers: {}, body: body === undefined ? undefined : Buffer.from(JSON.stringify(body)), fromApp: true }, undefined)) pieces.push(piece);
  const bytes = Buffer.concat(pieces.filter(each => each.body).map(each => each.body));
  let parsed = bytes.toString();
  try { parsed = JSON.parse(parsed); } catch {}
  return { status: pieces.find(each => each.head).head.status, body: parsed };
}
async function tool(name, args, session) {
  calling.set(session, { name, args });
  try {
    return (await route("POST", "kuvo/work-queue/tools", { name, arguments: args, session })).body;
  } finally {
    calling.delete(session);
  }
}
const view = async owner => (await route("GET", `kuvo/work-queue?owner=${owner}`)).body;

// An item as another computer tells it.
const told = (number, owner, extra = {}) => ({
  id: `wqi_${String(number).padStart(20, "0")}`, number, owner, title: `Item ${number}`, category: "next", order: number, inProgress: false, sessions: [], noteCount: 0, fileCount: 0, linkCount: 0,
  created: { at: 1000, by: { session: owner, name: "Far" } }, updated: { at: 2000, by: { session: owner, name: "Far" } }, ...extra,
});
const telling = (items, extra = {}) => ({ told: { id: `wqt_${crypto.randomBytes(9).toString("base64url")}`, at: Date.now(), kind: "machine", since: 5000, items, owners: [{ owner: "ses_far", kind: "session", title: "Far away" }], categories: [], ...extra } });

beforeEach(() => {
  fs.rmSync(ghAsked, { force: true });
  fs.rmSync(ghAnswer, { force: true });
  fs.rmSync(run, { recursive: true, force: true });
  fs.mkdirSync(run, { recursive: true });
  write(path.join(run, "engine.json"), { ...target, version: "0.0.0" });
  sent.length = 0;
  calling.clear();
  link.forgetQueuesTold();
  link.forgetQueueActs();
  link.queueForwardsSoon.send = () => {};
  link.queueForwardTiming.wait = 20_000;
  fresh();
  agentsTold();
});

test("what your other computers told shows in the All view and a lead's view, with the computer it's on; chips and its page answer from it; it's changed there", async () => {
  // This box's own, numbered from a block its Mac gave.
  write(path.join(queues, "numbers.json"), { primary: mac.pub, leases: [[100, 149]] });
  const own = await tool("queue_add", { title: "Ship the release" }, "ses_lead");
  assert.match(own.text, /^Added #100 /);
  // On lab: a session the lead started there (lab's rows say so), a stranger's, and one the lead
  // handed to a session there.
  write(path.join(run, "work", "elsewhere", `${lab.pub}.json`), { at: Date.now(), heard: Date.now(), leads: { ses_lead: [{ session: "ses_far", title: "Far away", folder: "", startedBy: "ses_lead", depth: 1, state: "idle", started: 1, tokens: 0 }] } });
  const tellsNow = telling([told(500, "ses_far", { progress: { note: "Writing the test" }, inProgress: true }), told(501, "ses_stranger"), told(502, "ses_bob", { handedBy: "ses_lead" })]);
  receive(lab, { workQueue: tellsNow });
  assert.deepEqual(mailTo(lab).map(each => each.workQueue), [{ had: tellsNow.told.id }], "lab hears this box has it");

  const lead = await view("ses_lead");
  assert.deepEqual(new Set(lead.items.map(item => item.number)), new Set([100, 500, 502]), "its own, its session's on lab, and the one it handed there; never a stranger's");
  const far = lead.items.find(item => item.number === 500);
  assert.deepEqual(far.computer, { key: lab.pub, name: "lab", kind: "machine", id: "lab" });
  assert.equal(far.progress.note, "Writing the test");
  assert.equal(far.inProgress, true);
  assert.equal(lead.owners.find(each => each.owner === "ses_far")?.title, "Far away");
  const all = await view("all");
  assert.deepEqual(new Set(all.items.map(item => item.number)), new Set([100, 500, 501, 502]));
  assert.deepEqual(all.computers.map(each => each.name), ["lab"]);

  // A chip, and the item's page: as lab told it, without what only lab keeps.
  const refs = (await route("GET", "kuvo/work-queue/refs?refs=500,999,100")).body.refs;
  assert.equal(refs["500"].title, "Item 500");
  assert.equal(refs["500"].computer.name, "lab");
  assert.equal(refs["999"], null);
  assert.equal(refs["100"].computer, undefined);
  const posted = (await route("POST", "kuvo/work-queue/refs", { refs: ["#500", "gh:owner/repo#12"] })).body.refs;
  assert.equal(posted["#500"].number, 500);
  assert.equal(posted["gh:owner/repo#12"], null, "an outside ref no source answers yet stays plain text");
  const page = await route("GET", "kuvo/work-queue/items/500");
  assert.equal(page.status, 200);
  assert.equal(page.body.item.computer.id, "lab");
  assert.equal(page.body.item.body, "");

  // You change it on lab; an agent asks the conversation it belongs to.
  const moved = await route("DELETE", "kuvo/work-queue/items/500");
  assert.equal(moved.status, 409);
  assert.equal(moved.body.computer.id, "lab");
  assert.match(moved.body.message, /#500 "Item 500" is on lab: change it there\./);
  const listed = await tool("queue_list", {}, "ses_lead");
  assert.match(listed.text, /On your other computers \(as each last told it; changed there\):\n- #500 "Item 500" · in progress: Writing the test · in "Far away" \(ses_far\) · on lab, updated/);
  assert.doesNotMatch(listed.text, /#501/);
  const changed = await tool("queue_update", { item: "#500", note: "Hi" }, "ses_lead");
  assert.equal(changed.isError, true);
  assert.match(changed.text, /#500 "Item 500" is on lab, in the queue of ses_far: it's changed there\./);
  const shown = await tool("queue_show", { item: 500 }, "ses_lead");
  assert.match(shown.text, /^#500 "Item 500" · In progress \(kept in Next\) · on lab, in the queue of ses_far/);

  // What lab told a moment before, come late, isn't kept over what it told since, nor said to be
  // had (had, lab would never send it again, were it what lab tells next).
  const late = telling([told(503, "ses_far")], { at: tellsNow.told.at - 5000 });
  receive(lab, { workQueue: late });
  assert.deepEqual(mailTo(lab), []);
  assert.equal((await view("all")).items.some(item => item.number === 503), false);
  // The same again (lab's had lost): had again.
  receive(lab, { workQueue: tellsNow });
  assert.deepEqual(mailTo(lab).map(each => each.workQueue), [{ had: tellsNow.told.id }]);
  // One an hour "older" is lab's clock set back: its newer word after all.
  const setBack = telling([told(504, "ses_far")], { at: tellsNow.told.at - 3_600_000 });
  receive(lab, { workQueue: setBack });
  sent.length = 0;
  assert.equal((await view("all")).items.some(item => item.number === 504), true);
  receive(lab, { workQueue: tellsNow });
  sent.length = 0;
  // An agent reads one on another computer only when it's in its view, as here.
  const notTheirs = await tool("queue_show", { item: 501 }, "ses_lead");
  assert.equal(notTheirs.isError, true);
  assert.match(notTheirs.text, /#501 "Item 501" is on lab, and isn't in your Work Queue/);
  // A box that isn't one of your computers isn't heard at all.
  const stranger = box("machine", "stranger");
  link.receiveMail(link.sealOneWay(Buffer.from(JSON.stringify({ workQueue: telling([told(600, "ses_x")]), at: Date.now() })), stranger.key, link.publicOf(here.key)).message, host, (sender, given) => link.peerMail(sender, given, host, places));
  assert.equal((await view("all")).items.some(item => item.number === 600), false);
});

test("an item on another computer linked to a session here shows in that session's view, and its agent can't change it", async () => {
  // Lab's lead put ses_child (here) on its item: lab tells it with ses_child among its sessions.
  receive(lab, { workQueue: telling([told(700, "ses_far", { sessions: [{ session: "ses_child", title: "Sign-in", working: false }] }), told(701, "ses_far")]) });
  sent.length = 0;
  const worker = await view("ses_child");
  assert.deepEqual(worker.items.map(item => item.number), [700]);
  assert.equal(worker.items[0].computer.name, "lab");
  assert.equal(worker.owners.find(each => each.owner === "ses_far")?.title, "Far away");
  // Seeing only: not in what its tools list or change.
  assert.doesNotMatch((await tool("queue_list", {}, "ses_child")).text, /#700/);
  assert.equal((await tool("queue_update", { item: 700, note: "Hi" }, "ses_child")).isError, true);
});

test("a computer that isn't answering: its items show as it last told them, none of them in progress, and say since when; heard again, they're as it tells them", async () => {
  const tellsNow = telling([told(500, "ses_far", { inProgress: true, progress: { note: "Writing the test" }, sessions: [{ session: "ses_far", title: "Far away", working: true }] }), told(501, "ses_far")]);
  receive(lab, { workQueue: tellsNow });
  const live = await view("all");
  assert.equal(live.items.find(item => item.number === 500).inProgress, true, "at work as lab says, while lab answers");
  assert.equal(live.computers[0].away, undefined);

  // The relay finds nothing connected at lab (it's switched off).
  const since = Date.now() - 60_000;
  write(path.join(run, "peer-reach.json"), { [lab.pub]: since });
  const away = await view("all");
  const item = away.items.find(each => each.number === 500);
  assert.equal(item.inProgress, false, "nothing on a computer that's off can be seen at work");
  assert.deepEqual(item.sessions.map(each => each.working), [false]);
  assert.equal(item.progress.note, "Writing the test", "what it said is kept");
  assert.deepEqual(away.computers.map(each => [each.name, each.away]), [["lab", since]]);
  assert.equal((await route("GET", "kuvo/work-queue/refs?refs=500")).body.refs["500"].inProgress, false, "its chip says so too");
  assert.equal((await route("GET", "kuvo/work-queue/items/500")).body.item.inProgress, false, "and its page");

  // Lab's mail comes again: it answers.
  receive(lab, { workQueue: telling([told(500, "ses_far", { inProgress: true, sessions: [{ session: "ses_far", title: "Far away", working: true }] })]) });
  const back = await view("all");
  assert.equal(back.items.find(each => each.number === 500).inProgress, true);
  assert.equal(back.computers[0].away, undefined);
});

test("this box tells your other computers its queue as it changes: again until it's had, then not until it changes; too big for one mail, in parts", async () => {
  write(path.join(queues, "numbers.json"), { primary: mac.pub, leases: [[100, 149]] });
  await tool("queue_add", { title: "Fix the login page" }, "ses_child");
  const now = Date.now();
  await link.pushQueues(host, link.readLink(), targets, now);
  const toLab = mailTo(lab);
  assert.equal(toLab.length, 1);
  const first = toLab[0].workQueue.told;
  assert.deepEqual(first.items.map(item => [item.number, item.title, item.owner]), [[100, "Fix the login page", "ses_child"]]);
  assert.deepEqual(first.owners.find(each => each.owner === "ses_child"), { owner: "ses_child", kind: "session", title: "Sign-in", startedBy: "ses_lead" });
  assert.equal(first.kind, "machine");
  assert.deepEqual(first.primary, { key: mac.pub, kind: "mac" }, "it numbers from its Mac");
  assert.ok(first.top >= 149, "it tells the highest number it holds");
  assert.equal(mailTo(mac).length, 1, "its Mac is told too");
  // Nothing again while it isn't had yet and a minute hasn't gone by; again after.
  await link.pushQueues(host, link.readLink(), targets, now + 1000);
  assert.equal(sent.length, 0);
  await link.pushQueues(host, link.readLink(), targets, now + 61_000);
  assert.equal(mailTo(lab)[0].workQueue.told.id, first.id);
  sent.length = 0;
  // Had: nothing more while it's the same.
  receive(lab, { workQueue: { had: first.id } });
  sent.length = 0;
  await link.pushQueues(host, link.readLink(), targets, now + 200_000);
  assert.equal(mailTo(lab).length, 0);
  sent.length = 0;

  // Too big for one mail: in parts, kept once the last is here, and never from part of it.
  const many = Array.from({ length: 400 }, (_, index) => told(1000 + index, "ses_far", { title: `${"A long title that fills the mail ".repeat(5)} ${index}`.slice(0, 200), progress: { note: "x".repeat(290) } }));
  const big = telling(many);
  const mails = link.queueMailsFor(here.peer, big, link.readLink());
  assert.ok(mails.length > 2, `${mails.length} parts`);
  // (Sealed for this box by lab: the same parts, as lab would send them.)
  const parts = mails.map(bytes => JSON.parse(link.openOneWay(link.readFrame(bytes.subarray(17)).body, here.key, link.publicOf(here.key)).payload.toString("utf8")).workQueue.part);
  for (const part of parts.slice(0, -1)) receive(lab, { workQueue: { part } });
  assert.equal((await view("all")).items.some(item => item.number === 1000), false, "not until the last part");
  receive(lab, { workQueue: { part: parts.at(-1) } });
  assert.equal((await view("all")).items.filter(item => item.computer?.name === "lab").length, 400);
  assert.deepEqual(mailTo(lab).map(each => each.workQueue), [{ had: big.told.id }]);
  // A part that isn't the whole's (its digest doesn't hold) puts nothing together.
  const bad = telling([told(2000, "ses_far")]);
  const badParts = link.queueMailsFor(here.peer, { ...bad, padding: "y".repeat(90_000) }, link.readLink()).map(bytes => JSON.parse(link.openOneWay(link.readFrame(bytes.subarray(17)).body, here.key, link.publicOf(here.key)).payload.toString("utf8")).workQueue.part);
  badParts[0] = { ...badParts[0], d: badParts[0].d.replace(/^./, c => (c === "A" ? "B" : "A")) };
  for (const part of badParts) receive(lab, { workQueue: { part } });
  assert.equal((await view("all")).items.some(item => item.number === 2000), false);
});

test("numbers come from the first computer you set up: a Mac before a machine, the earlier of two Macs; a box hears of an earlier one and moves to it, never back", () => {
  const file = path.join(queues, "numbers.json");
  // A machine set up from two Macs, the later one last (piece 1 took that one): neither told yet.
  fresh({ macs: [mac, later] });
  write(file, { primary: later.pub, leases: [[200, 249]] });
  assert.equal(link.primaryOf(link.readLink()).peer.key, later.pub, "kept, while nothing says another was set up first");
  // Each tells when it was set up: the earlier one is the primary; lab, a machine set up "earlier"
  // still, never is while there's a Mac.
  write(path.join(queues, "peers", `${mac.pub}.json`), { id: "wqt_aaaaaaaaaaaa", at: 1, heard: 1, kind: "mac", since: 1_000, items: [], owners: [], categories: [] });
  write(path.join(queues, "peers", `${later.pub}.json`), { id: "wqt_bbbbbbbbbbbb", at: 1, heard: 1, kind: "mac", since: 9_000, items: [], owners: [], categories: [] });
  write(path.join(queues, "peers", `${lab.pub}.json`), { id: "wqt_cccccccccccc", at: 1, heard: 1, kind: "machine", since: 10, items: [], owners: [], categories: [] });
  assert.equal(link.primaryOf(link.readLink()).peer.key, mac.pub);
  link.notePrimaryNow(link.readLink());
  assert.equal(link.readNumbers(file).primary, mac.pub, "noted");
  // Never back to the later one, whatever it says next; and never away from the one kept for one
  // that hasn't said when it was set up (an older box mid-update): only for one known to be earlier.
  write(file, { ...link.readNumbers(file), primary: later.pub });
  write(path.join(queues, "peers", `${later.pub}.json`), { id: "wqt_bbbbbbbbbbbb", at: 1, heard: 1, kind: "mac", items: [], owners: [], categories: [] });
  assert.equal(link.primaryOf(link.readLink()).peer.key, later.pub, "kept: it hasn't said, and may be the first");
  write(path.join(queues, "peers", `${later.pub}.json`), { id: "wqt_bbbbbbbbbbbb", at: 1, heard: 1, kind: "mac", since: 9_000, items: [], owners: [], categories: [] });
  assert.equal(link.primaryOf(link.readLink()).peer.key, mac.pub, "once it says, the earlier one");
  write(file, { ...link.readNumbers(file), primary: mac.pub });
  write(path.join(queues, "peers", `${later.pub}.json`), { id: "wqt_bbbbbbbbbbbb", at: 2, heard: 2, kind: "mac", since: 9_000, items: [], owners: [], categories: [], primary: { key: later.pub, kind: "mac", since: 9_000 } });
  assert.equal(link.primaryOf(link.readLink()).peer.key, mac.pub);

  // A Mac this box can't write to (not one of its own), set up first, as lab says: reached through lab.
  const first = box("mac", "Old Mac");
  write(path.join(queues, "peers", `${lab.pub}.json`), { id: "wqt_cccccccccccc", at: 3, heard: 3, kind: "machine", since: 10, items: [], owners: [], categories: [], primary: { key: first.pub, kind: "mac", since: 500 } });
  const through = link.primaryOf(link.readLink());
  assert.equal(through.peer.key, first.pub);
  assert.equal(through.via.key, lab.pub);
  // Its ask goes through lab, naming that Mac, with the highest number this box holds.
  write(file, { ...link.readNumbers(file), asking: { id: "wqn_throughlab01", count: 50, since: 1 } });
  sent.length = 0;
  link.pushNumbers(host, link.readLink());
  const asked = mailTo(lab).map(each => each.workQueue);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].to, first.pub);
  assert.equal(asked[0].ask.id, "wqn_throughlab01");
  assert.ok(asked[0].ask.top >= 249);
  // The block comes back through lab: taken.
  receive(lab, { workQueue: { give: { id: "wqn_throughlab01", from: 900, to: 949, granted: [] } } });
  assert.deepEqual(link.readNumbers(file).leases.at(-1), [900, 949]);

  // lab stops naming it a while (it can't say now): this box waits rather than going back to its
  // Mac; only once it's gone unheard of for days does it take the next.
  link.notePrimaryNow(link.readLink());
  assert.equal(link.readNumbers(file).primary, first.pub);
  write(path.join(queues, "peers", `${lab.pub}.json`), { id: "wqt_cccccccccccc", at: 4, heard: 4, kind: "machine", since: 10, items: [], owners: [], categories: [] });
  assert.deepEqual(link.primaryOf(link.readLink()), { away: true });
  link.notePrimaryNow(link.readLink());
  const lost = link.readNumbers(file).lost;
  assert.ok(lost, "noted since when");
  assert.deepEqual(link.primaryOf(link.readLink(), file, lost + 86_400_000), { away: true });
  assert.equal(link.primaryOf(link.readLink(), file, lost + 4 * 86_400_000).peer.key, mac.pub);
});

test("a machine in a setup numbers from its main computer, whatever a peer says of a Mac set up earlier; one Macs share outside one setup works it out as before, and says it's shared", async () => {
  const file = path.join(queues, "numbers.json");
  // Its Mac leads a setup, as the Mac's signed peers document says.
  const seed = link.newSigningSeed();
  const sign = link.signingKeyOf(seed);
  const body = { boxes: [{ ...mac.peer, sign }, lab.peer, here.peer], moved: [], left: [], setup: { id: "set_AAAAAAAAAAAAAAAAAAAAAA", epoch: 1, primary: mac.pub } };
  link.updateLink(() => ({ secret: crypto.randomBytes(32).toString("base64url"), key: k(here.key), sign: link.newSigningSeed(), relay: "wss://relay.test", name: "devbox", id: "devbox", mac: mac.pub, macs: [mac.pub], macSigns: { [mac.pub]: sign }, phones: [] }));
  link.updateLink(current => { link.docsWork({ link: current, library: { personalities: [], removed: [] } }, { key: mac.pub, sign }, { give: [link.signDoc(seed, "peers", 1, body)] }); return current; });
  assert.equal(link.readLink().setup?.primary, mac.pub);
  write(file, { primary: mac.pub, leases: [], asking: { id: "wqn_tothemainmac01", count: 50, since: 1 } });
  // lab says it numbers from a Mac set up earlier (as piece 3 would follow): this box doesn't.
  const first = box("mac", "Old Mac");
  write(path.join(queues, "peers", `${lab.pub}.json`), { id: "wqt_cccccccccccc", at: 3, heard: 3, kind: "machine", since: 10, items: [], owners: [], categories: [], primary: { key: first.pub, kind: "mac", since: 500 } });
  assert.deepEqual(link.primaryOf(link.readLink(), file), { peer: link.peersOf(link.readLink()).find(peer => peer.key === mac.pub) });
  link.notePrimaryNow(link.readLink(), { file });
  assert.equal(link.readNumbers(file).primary, mac.pub);
  sent.length = 0;
  link.pushNumbers(host, link.readLink());
  assert.equal(mailTo(lab).length, 0, "nothing through lab");
  const asked = mailTo(mac).map(each => each.workQueue);
  assert.equal(asked[0]?.ask?.id, "wqn_tothemainmac01");
  assert.equal(asked[0].to, undefined, "to its main computer itself");
  // It tells your other computers it isn't shared.
  await link.pushQueues(host, link.readLink(), targets, Date.now());
  assert.equal(mailTo(lab)[0].workQueue.told.shared, false);

  // A second Mac sets it up, in no one setup: it sets its setup aside, numbers as before, and says
  // it's shared.
  const second = link.newSigningSeed();
  link.updateLink(current => {
    current.macs = [mac.pub, later.pub];
    current.macSigns = { ...current.macSigns, [later.pub]: link.signingKeyOf(second) };
    link.docsWork({ link: current, library: { personalities: [], removed: [] } }, { key: later.pub, sign: link.signingKeyOf(second) }, { give: [link.signDoc(second, "peers", 1, { boxes: [{ ...later.peer, sign: link.signingKeyOf(second) }, here.peer], moved: [], left: [] })] });
    return current;
  });
  assert.equal(link.readLink().setup.aside, true);
  sent.length = 0;
  link.forgetQueuesTold();
  // (What it tells is made again at most once a minute.)
  await link.pushQueues(host, link.readLink(), targets, Date.now() + 120_000);
  assert.equal(mailTo(lab)[0].workQueue.told.shared, true);
  assert.equal(link.followedSetup(link.readLink()), null);
  assert.deepEqual(link.primaryOf(link.readLink(), file), link.rankedPrimary(link.readLink(), file), "numbering as piece 3 has it");
  sent.length = 0;
});

test("a machine its main computer lets go (removed, or not heard from in 30 days) doesn't number on its own at once: it waits for that Mac, as numbering always has, days, before it does", () => {
  const file = path.join(queues, "numbers.json");
  const seed = link.newSigningSeed();
  const sign = link.signingKeyOf(seed);
  const leads = { setup: { id: "set_BBBBBBBBBBBBBBBBBBBBBB", epoch: 1, primary: mac.pub } };
  const library = { personalities: [], removed: [] };
  link.updateLink(() => ({ secret: crypto.randomBytes(32).toString("base64url"), key: k(here.key), sign: link.newSigningSeed(), relay: "wss://relay.test", name: "devbox", id: "devbox", mac: mac.pub, macs: [mac.pub], macSigns: { [mac.pub]: sign }, phones: [] }));
  link.updateLink(current => { link.docsWork({ link: current, library }, { key: mac.pub, sign }, { give: [link.signDoc(seed, "peers", 1, { boxes: [{ ...mac.peer, sign }, lab.peer, here.peer], moved: [], left: [], ...leads })] }); return current; });
  write(file, { primary: mac.pub, leases: [], since: 9_000 });
  assert.equal(link.readLink().setup?.role, "member");
  // Its Mac removes it.
  link.updateLink(current => { link.docsWork({ link: current, library }, { key: mac.pub, sign }, { give: [link.signDoc(seed, "peers", 2, { boxes: [{ ...mac.peer, sign }, lab.peer], moved: [], left: [here.pub], ...leads })] }); return current; });
  link.noteSetupNow(Date.now(), { soon: 0 });
  assert.equal(link.readLink().setup, undefined, "it leads none yet");
  assert.deepEqual(link.primaryOf(link.readLink(), file), { away: true }, "its items wait, as before");
  // Days on, unheard: it numbers on its own, and leads a setup of its own.
  link.notePrimaryNow(link.readLink(), { file });
  const lost = link.readNumbers(file).lost;
  assert.ok(lost);
  write(file, { ...link.readNumbers(file), lost: lost - 4 * 86_400_000 });
  link.noteSetupNow(Date.now(), { soon: 0 });
  assert.equal(link.readLink().setup?.role, "primary");
  assert.deepEqual(link.primaryOf(link.readLink(), file), { self: true });
});

test("a box asked for numbers on behalf of its primary passes the ask on and the block back, one hop", () => {
  const file = path.join(queues, "numbers.json");
  write(file, { primary: mac.pub, leases: [[100, 149]] });
  // lab can't write to this box's Mac: it asks through this box.
  receive(lab, { workQueue: { ask: { id: "wqn_labaskslab01", count: 50, top: 70 }, to: mac.pub } });
  assert.deepEqual(mailTo(mac).map(each => each.workQueue), [{ ask: { id: "wqn_labaskslab01", count: 50, top: 70 }, for: lab.pub }]);
  // The Mac's block for lab, back to lab; one for no one this box knows goes nowhere.
  receive(mac, { workQueue: { give: { id: "wqn_labaskslab01", from: 300, to: 349, granted: [] }, for: lab.pub } });
  assert.deepEqual(mailTo(lab).map(each => each.workQueue), [{ give: { id: "wqn_labaskslab01", from: 300, to: 349, granted: [] } }]);
  assert.deepEqual(link.readNumbers(file).leases, [[100, 149]], "not this box's");
  // An ask for another primary than this box's isn't passed on; nor one passed on already.
  receive(lab, { workQueue: { ask: { id: "wqn_labaskslab02", count: 50 }, to: later.pub } });
  receive(lab, { workQueue: { ask: { id: "wqn_labaskslab03", count: 50 }, to: mac.pub, for: here.pub } });
  assert.equal(sent.length, 0);
});

test("the primary moves past what a box that numbered on its own used, and what any of your computers tell it they hold", () => {
  const file = path.join(queues, "primary-numbers.json");
  assert.equal(link.takeNumber({ self: true }, { file }), 1);
  const block = link.giveBlock("box-a", { id: "wqn_movedpast001", count: 50, top: 480 }, { file });
  assert.deepEqual([block.from, block.to], [481, 530], "past the 480 it used");
  assert.deepEqual(link.giveBlock("box-a", { id: "wqn_movedpast001", count: 50, top: 9000 }, { file }), block, "an ask sent again gets the same block");
  // A number an import was refused (far past the others) never moves the counter, nor does a top
  // past what a chip reads.
  const far = link.giveBlock("box-b", { id: "wqn_movedpast002", count: 50, top: 999_999 }, { file });
  assert.ok(far.to < 1_000_000, `${far.from}–${far.to} still reads as a chip`);
  // A box that was its own primary and isn't now asks at once.
  const own = path.join(queues, "numbers.json");
  write(own, { primary: "self", next: 77, leases: [] });
  link.notePrimaryNow(link.readLink());
  const kept = link.readNumbers(own);
  assert.equal(kept.primary, mac.pub, "a machine set up from a Mac never numbers on its own");
  assert.ok(kept.asking, "and asks its Mac at once");
  assert.ok(link.askToSend({ file: own, now: Date.now() }).top >= 76, "telling it how far it got");
});

test("an item handed to a session on another computer moves once: unchanged here until that one has it, sent again until then, gone from here once it's had; one refused comes back with why", async () => {
  write(path.join(queues, "numbers.json"), { primary: mac.pub, leases: [[100, 149]] });
  const added = await tool("queue_add", { title: "Port the importer", body: "Use the **new** parser." }, "ses_lead");
  assert.match(added.text, /^Added #100 /);
  const handed = await tool("queue_hand", { item: "#100", to: "ses_far" }, "ses_lead");
  assert.equal(handed.isError, false, handed.text);
  assert.match(handed.text, /^Handing #100 "Port the importer" to Far on lab: it goes into its queue there/);
  const meanwhile = await tool("queue_update", { item: "#100", note: "More" }, "ses_lead");
  assert.equal(meanwhile.isError, true);
  assert.match(meanwhile.text, /is being handed to Far on another computer/);
  assert.equal((await route("POST", "kuvo/work-queue/items/100/move", { category: "later" })).status, 400);
  // It goes to lab with this box's rounds, whole; again after a minute while lab doesn't say.
  const now = Date.now();
  await link.pushQueues(host, link.readLink(), targets, now);
  const hand = mailTo(lab).map(each => each.workQueue).find(each => each.hand)?.hand;
  assert.equal(hand.to, "ses_far");
  assert.equal(hand.from, "ses_lead");
  assert.equal(hand.item.number, 100);
  assert.equal(hand.item.body, "Use the **new** parser.");
  await link.pushQueues(host, link.readLink(), targets, now + 1000);
  assert.equal(mailTo(lab).filter(each => each.workQueue.hand).length, 0);
  await link.pushQueues(host, link.readLink(), targets, now + 61_000);
  assert.equal(mailTo(lab).filter(each => each.workQueue.hand).length, 1);
  // Only lab's word counts; then it's gone from here.
  receive(mac, { workQueue: { handed: { id: hand.id, ok: true } } });
  assert.equal((await view("ses_lead")).items.some(item => item.number === 100 && !item.computer), true);
  receive(lab, { workQueue: { handed: { id: hand.id, ok: true } } });
  assert.equal((await view("all")).items.some(item => item.number === 100), false);

  // One lab says to send again later (its conversation moving): again at its next minute, not at once.
  await tool("queue_add", { title: "Retry me" }, "ses_lead");
  await tool("queue_hand", { item: "#101", to: "ses_far" }, "ses_lead");
  await link.pushQueues(host, link.readLink(), targets, now + 100_000);
  const retried = mailTo(lab).map(each => each.workQueue).find(each => each.hand)?.hand;
  receive(lab, { workQueue: { handed: { id: retried.id, ok: false, retry: true } } });
  await link.pushQueues(host, link.readLink(), targets, Date.now());
  assert.equal(mailTo(lab).filter(each => each.workQueue.hand).length, 0, "not at once");
  receive(lab, { workQueue: { handed: { id: retried.id, ok: true } } });

  // One lab can't take comes back as it was, with why.
  await tool("queue_add", { title: "Second" }, "ses_lead");
  await tool("queue_hand", { item: "#102", to: "Wren" }, "ses_lead");
  await link.pushQueues(host, link.readLink(), targets, now + 200_000);
  const second = mailTo(lab).map(each => each.workQueue).find(each => each.hand)?.hand;
  assert.equal(second.to, "ses_wren", "a bot on lab, by its name");
  receive(lab, { workQueue: { handed: { id: second.id, ok: false, why: "That queue has 2,000 open items already." } } });
  const back = await tool("queue_show", { item: 102 }, "ses_lead");
  assert.match(back.text, /Couldn't be handed to Wren on another computer: That queue has 2,000 open items already\. It's still here\./);
  assert.equal((await tool("queue_update", { item: 102, note: "ok" }, "ses_lead")).isError, false);

  // To a computer that runs an older Kuvo Code: refused, saying so.
  agentsTold({ [lab.pub]: { at: 1, heard: Date.now(), kind: "machine", id: "lab", list: [{ session: "ses_far", name: "Far", kind: "session" }], features: ["work-queue"] } });
  const older = await tool("queue_hand", { item: 102, to: "ses_far" }, "ses_lead");
  assert.equal(older.isError, true);
  assert.match(older.text, /runs an older Kuvo Code/);
});

test("an item handed here from another computer lands in its conversation's queue once, linked to it, with its files; one for no conversation here is refused", async () => {
  const id = "wqi_handedfromlab0000001";
  const item = told(700, "ses_farlead", { id, body: "From lab.", notes: [{ at: 1, by: { source: "github", name: "octocat" }, text: "Seen upstream" }], files: [{ name: "shot.png", size: 3, type: "image/png", at: 1 }], links: [], handed: [] });
  const hand = { id: "wqh_fromlab00000001", to: "ses_child", from: "ses_farlead", by: { session: "ses_farlead", name: "Far lead" }, at: Date.now(), item, files: [{ name: "shot.png", data: Buffer.from("png").toString("base64") }] };
  await takeFrom(lab, { hand });
  assert.deepEqual(mailTo(lab).map(each => each.workQueue), [{ handed: { id: hand.id, ok: true } }]);
  const landed = (await route("GET", "kuvo/work-queue/items/700")).body.item;
  assert.equal(landed.owner, "ses_child");
  assert.equal(landed.body, "From lab.");
  assert.deepEqual(landed.sessions.map(each => each.session), ["ses_child"]);
  assert.equal(landed.handedBy, "ses_farlead");
  assert.deepEqual(landed.notes[0].by, { source: "github", name: "octocat" }, "an outside tracker's author kept as it was");
  assert.equal(fs.readFileSync(path.join(queues, "files", id, "shot.png"), "utf8"), "png");
  // Sent again (lab didn't hear the answer): had, still once.
  await takeFrom(lab, { hand });
  assert.deepEqual(mailTo(lab).map(each => each.workQueue), [{ handed: { id: hand.id, ok: true } }]);
  assert.equal((await view("all")).items.filter(each => each.number === 700).length, 1);
  // Handed back here before this box heard it arrived there (its receipt lost): it waits.
  write(path.join(queues, "numbers.json"), { primary: mac.pub, leases: [[100, 149]] });
  await tool("queue_add", { title: "Round trip" }, "ses_lead");
  await tool("queue_hand", { item: "#100", to: "ses_far" }, "ses_lead");
  const mine = (await route("GET", "kuvo/work-queue/items/100")).body.item;
  await takeFrom(lab, { hand: { ...hand, id: "wqh_fromlab00000009", to: "ses_lead", item: { ...told(100, "ses_far"), id: mine.id } } });
  const waits = mailTo(lab).map(each => each.workQueue.handed);
  assert.equal(waits[0].ok, false);
  assert.equal(waits[0].retry, true);
  assert.equal((await view("all")).items.filter(each => each.id === mine.id).length, 1);
  // For no conversation here.
  await takeFrom(lab, { hand: { ...hand, id: "wqh_fromlab00000002", to: "ses_nobody", item: { ...item, id: "wqi_handedfromlab0000002" } } });
  const refused = mailTo(lab).map(each => each.workQueue.handed);
  assert.equal(refused[0].ok, false);
  assert.match(refused[0].why, /There's no conversation ses_nobody on /);
});

test("a hand-off to a computer that's no longer one of yours comes back after a few days, relay or not; one that waits 30 days too; deleting one calls it off; and what had got there stays there's", async () => {
  write(path.join(queues, "numbers.json"), { primary: mac.pub, leases: [[100, 149]] });
  await tool("queue_add", { title: "Stuck" }, "ses_lead");
  assert.equal((await tool("queue_hand", { item: "#100", to: "ses_far" }, "ses_lead")).isError, false);
  // lab drops out of the list of your computers, the only one that took the Work Queue's mail:
  // the hand-off waits a while (a computer can be missing a moment), then comes back, though
  // nothing's told now.
  fresh({ peers: [mac, here] });
  agentsTold({ [mac.pub]: { at: 1, heard: Date.now(), kind: "mac", list: [], features: ["work-queue"] } });
  const now = Date.now();
  await link.pushQueues(host, link.readLink(), targets, now);
  assert.equal((await view("ses_lead")).items.find(item => item.number === 100).handing?.to, "ses_far", "a moment missing: still on its way");
  await link.pushQueues(host, link.readLink(), targets, now + 4 * 86_400_000);
  const back = await tool("queue_show", { item: 100 }, "ses_lead");
  assert.match(back.text, /Couldn't be handed to Far on another computer: that computer hasn't been one of yours for 3 days\. It's still here\./);
  assert.equal((await tool("queue_update", { item: 100, note: "Mine again" }, "ses_lead")).isError, false);

  // One waiting on lab while this box is off the relay: given up after 30 days all the same.
  fresh();
  agentsTold();
  assert.equal((await tool("queue_hand", { item: "#100", to: "ses_far" }, "ses_lead")).isError, false);
  link.handUpkeep(link.readLink(), Date.now() + 1000);
  assert.equal((await view("ses_lead")).items.find(item => item.number === 100).handing?.to, "ses_far", "on its way still");
  link.handUpkeep(link.readLink(), Date.now() + 31 * 86_400_000);
  assert.match((await tool("queue_show", { item: 100 }, "ses_lead")).text, /it couldn't be reached for 30 days\. It's still here\./);

  // You delete one on its way: its hand-off is called off, and it goes no more.
  await tool("queue_hand", { item: "#100", to: "ses_far" }, "ses_lead");
  const deleted = await route("DELETE", "kuvo/work-queue/items/100");
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  sent.length = 0;
  await link.pushQueues(host, link.readLink(), targets, Date.now() + 120_000);
  assert.equal(mailTo(lab).filter(each => each.workQueue.hand).length, 0);
  const restored = await route("POST", "kuvo/work-queue/items/100/restore");
  assert.equal(restored.status, 200);
  assert.match((await tool("queue_show", { item: 100 }, "ses_lead")).text, /Its hand-off to Far on another computer was called off\./);
  // An agent's queue_remove calls one off too.
  await tool("queue_hand", { item: "#100", to: "ses_far" }, "ses_lead");
  assert.equal((await tool("queue_remove", { item: 100 }, "ses_lead")).isError, false);
  // One that had got to lab already (its receipt lost) is lab's: the copy deleted here never hides
  // it, and isn't brought back beside it.
  const id = (await view("ses_lead")).removed[0].id;
  receive(lab, { workQueue: telling([told(100, "ses_far", { id, title: "Stuck on lab", updated: { at: Date.now(), by: { user: true } } })]) });
  sent.length = 0;
  assert.equal((await view("all")).items.find(item => item.id === id)?.computer?.name, "lab");
  const twice = await route("POST", "kuvo/work-queue/items/100/restore");
  assert.equal(twice.status, 400);
  assert.match(twice.body.message, /is on lab now \(it got there before its hand-off was called off\): change it there\./);
  // lab hands it back here: the live one takes the deleted copy's place, never answered as had.
  await takeFrom(lab, { hand: { id: "wqh_backhere00000001", to: "ses_lead", from: "ses_far", by: { user: true }, at: Date.now(), item: { ...told(100, "ses_far", { id, title: "Stuck on lab" }), body: "Worked on there.", notes: [], files: [], links: [], handed: [] }, files: [] } });
  assert.deepEqual(mailTo(lab).map(each => each.workQueue), [{ handed: { id: "wqh_backhere00000001", ok: true } }]);
  const home = (await route("GET", `kuvo/work-queue/items/${id}`)).body.item;
  assert.equal(home.removed, undefined);
  assert.equal(home.body, "Worked on there.");
  assert.equal(home.owner, "ses_lead");

  // One lab handed here, deleted here before lab told again: lab's word of it on its way here
  // doesn't show it as lab's.
  const coming = "wqi_handedhereanddelete1";
  await takeFrom(lab, { hand: { id: "wqh_cominghere000001", to: "ses_lead", from: "ses_far", by: { user: true }, at: Date.now(), item: { ...told(300, "ses_far", { id: coming }), body: "", notes: [], files: [], links: [], handed: [] }, files: [] } });
  receive(lab, { workQueue: telling([told(300, "ses_far", { id: coming, handing: { to: "ses_lead", name: "Lead" } })]) });
  sent.length = 0;
  assert.equal((await route("DELETE", `kuvo/work-queue/items/${coming}`)).status, 200);
  assert.equal((await view("all")).items.some(item => item.id === coming), false);
});

test("what happened to an item goes with it to another computer, as its notes do, and comes in with one handed here", async () => {
  write(path.join(queues, "numbers.json"), { primary: mac.pub, leases: [[100, 149]] });
  await tool("queue_add", { title: "Port the importer", working: true }, "ses_lead");
  await route("POST", "kuvo/work-queue/items/100/move", { category: "later", top: true });
  const events = (await route("GET", "kuvo/work-queue/items/100")).body.item.events;
  assert.deepEqual(events.map(event => [event.kind, event.by]), [["started", { session: "ses_lead", name: "Lead" }], ["moved", { user: true }]]);
  assert.equal((await tool("queue_hand", { item: "#100", to: "ses_far" }, "ses_lead")).isError, false);
  await link.pushQueues(host, link.readLink(), targets, Date.now());
  const hand = mailTo(lab).map(each => each.workQueue).find(each => each.hand)?.hand;
  assert.deepEqual(hand.item.events, events, "it goes whole");
  receive(lab, { workQueue: { handed: { id: hand.id, ok: true } } });

  // One handed here keeps what happened to it there, who and when.
  const far = [{ at: 1500, by: { session: "ses_farlead", name: "Far lead" }, kind: "started" }, { at: 1600, by: { user: true }, kind: "moved", from: "next", to: "later" }];
  const item = told(701, "ses_farlead", { id: "wqi_handedfromlab0000003", body: "", notes: [], files: [], links: [], handed: [], events: far });
  await takeFrom(lab, { hand: { id: "wqh_fromlab00000003", to: "ses_child", from: "ses_farlead", by: { session: "ses_farlead", name: "Far lead" }, at: Date.now(), item, files: [] } });
  assert.equal(mailTo(lab)[0].workQueue.handed.ok, true);
  assert.deepEqual((await route("GET", "kuvo/work-queue/items/701")).body.item.events, far);
  // One handed here from an older box has none.
  await takeFrom(lab, { hand: { id: "wqh_fromlab00000004", to: "ses_child", from: "ses_farlead", by: { session: "ses_farlead", name: "Far lead" }, at: Date.now(), item: told(702, "ses_farlead", { id: "wqi_handedfromlab0000004", body: "", notes: [], files: [], links: [], handed: [] }), files: [] } });
  assert.deepEqual((await route("GET", "kuvo/work-queue/items/702")).body.item.events, []);
  // One in a category this box doesn't keep (none came with it) lands in Next, its feed saying so.
  await takeFrom(lab, { hand: { id: "wqh_fromlab00000005", to: "ses_child", from: "ses_farlead", by: { session: "ses_farlead", name: "Far lead" }, at: Date.now(), item: told(703, "ses_farlead", { id: "wqi_handedfromlab0000005", category: "cat_farcat", body: "", notes: [], files: [], links: [], handed: [], events: far }), files: [] } });
  const landed = (await route("GET", "kuvo/work-queue/items/703")).body.item;
  assert.equal(landed.category, "next");
  assert.deepEqual(landed.events.slice(0, 2), far);
  assert.deepEqual(landed.events.slice(2).map(({ at: _, ...event }) => event), [{ by: { source: "kuvo", name: "Kuvo Code" }, kind: "moved", from: "cat_farcat", to: "next" }]);
});

test("an item handed here without a number takes one as it arrives", async () => {
  write(path.join(queues, "numbers.json"), { primary: mac.pub, leases: [[100, 149]] });
  const { number: _, ...item } = told(1, "ses_farlead", { id: "wqi_handedwithoutnumber1", body: "", notes: [], files: [], links: [], handed: [] });
  await takeFrom(lab, { hand: { id: "wqh_nonumber00000001", to: "ses_child", from: "ses_farlead", by: { user: true }, at: Date.now(), item, files: [] } });
  assert.deepEqual(mailTo(lab).map(each => each.workQueue), [{ handed: { id: "wqh_nonumber00000001", ok: true } }]);
  assert.equal((await route("GET", "kuvo/work-queue/items/wqi_handedwithoutnumber1")).body.item.number, 100);
});

test("an outside source's item never takes a number an import claimed", async () => {
  const file = path.join(queues, "numbers.json");
  write(file, { primary: mac.pub, leases: [], asking: { id: "wqn_sourcesource01", count: 50, since: 1, claims: [[40, 41]] } });
  await tool("queue_add", { title: "Ours" }, "ses_lead");
  const lead = path.join(queues, "queues", "ses_lead.json");
  const kept = read(lead);
  kept.items.push({ ...kept.items[0], id: "wqi_sourcewantedsource01", wanted: 40, title: "An issue", source: { kind: "github", ref: "gh:o/r#1" } });
  kept.items.push({ ...kept.items[0], id: "wqi_importedwantedimp001", wanted: 41, title: "Imported" });
  write(lead, kept);
  assert.equal(link.blockArrived({ id: "wqn_sourcesource01", from: 300, to: 349, granted: [[40, 41]] }, link.primaryOf(link.readLink())), true);
  const items = (await view("ses_lead")).items;
  assert.equal(items.find(item => item.title === "An issue").number, undefined);
  assert.equal(items.find(item => item.title === "Imported").number, 41);
});

test("a duplicate told by two computers (one handed between them, the first not told again yet) shows once, as the newer word says", async () => {
  const id = "wqi_handedbetweenboxes01";
  receive(mac, { workQueue: telling([told(800, "ses_far", { id, title: "Stale", updated: { at: 2000, by: { user: true } } })], { kind: "mac" }) });
  receive(lab, { workQueue: telling([told(800, "ses_far", { id, title: "Live", updated: { at: 9000, by: { user: true } } })]) });
  sent.length = 0;
  const shown = (await view("all")).items.filter(item => item.id === id);
  assert.deepEqual(shown.map(item => [item.title, item.computer.name]), [["Live", "lab"]]);
  assert.equal((await route("GET", "kuvo/work-queue/refs?refs=800")).body.refs["800"].computer.name, "lab");
});

test("a change from a client tells your other computers sooner, never more often than every 15 seconds, and not what they have", async () => {
  write(path.join(queues, "numbers.json"), { primary: mac.pub, leases: [[100, 149]] });
  await tool("queue_add", { title: "First" }, "ses_lead");
  const now = Date.now();
  await link.pushQueues(host, link.readLink(), targets, now);
  assert.equal(mailTo(lab).length, 1);
  sent.length = 0;
  // You move it: lab hasn't said it has the first yet. Not within 15 seconds of the last.
  link.tellQueuesAgain();
  await link.pushQueues(host, link.readLink(), targets, now + 1000);
  assert.equal(mailTo(lab).length, 0, "not within 15 seconds");
  await link.pushQueues(host, link.readLink(), targets, now + 16_000);
  const again = mailTo(lab);
  assert.equal(again.length, 1, "sooner than a minute");
  sent.length = 0;
  // Had: a client's change that changed nothing told sends nothing.
  receive(lab, { workQueue: { had: again[0].workQueue.told.id } });
  receive(mac, { workQueue: { had: again[0].workQueue.told.id } });
  sent.length = 0;
  link.tellQueuesAgain();
  await link.pushQueues(host, link.readLink(), targets, now + 40_000);
  assert.equal(mailTo(lab).length, 0);
});

test("the primary's custom categories are this box's: added, renamed and removed as it says; one still in use here, and one only this box has, stay", async () => {
  write(path.join(queues, "numbers.json"), { primary: mac.pub, leases: [[100, 149]] });
  const names = async () => (await route("GET", "kuvo/work-queue/categories")).body.categories.filter(each => !each.builtIn).map(each => `${each.id}=${each.name}`);
  receive(mac, { workQueue: telling([], { kind: "mac", categories: [{ id: "cat_design", name: "Design" }, { id: "cat_review", name: "Review" }, { id: "cat_used", name: "Used" }] }) });
  assert.deepEqual(await names(), ["cat_design=Design", "cat_review=Review", "cat_used=Used"]);
  await tool("queue_categories", { add: "Mine" }, "ses_lead");
  await tool("queue_add", { title: "In use", category: "Used" }, "ses_lead");
  receive(mac, { workQueue: telling([], { kind: "mac", categories: [{ id: "cat_review", name: "Reviewing" }] }) });
  assert.deepEqual(await names(), ["cat_review=Reviewing", "cat_used=Used", "cat_mine=Mine"]);
  // Not from another computer than the primary.
  receive(lab, { workQueue: telling([], { categories: [{ id: "cat_labs", name: "Lab's" }] }) });
  assert.deepEqual(await names(), ["cat_review=Reviewing", "cat_used=Used", "cat_mine=Mine"]);
  // Emptied here, the one the primary removed goes with its next word.
  await tool("queue_update", { item: 100, category: "Next" }, "ses_lead");
  receive(mac, { workQueue: telling([], { kind: "mac", categories: [{ id: "cat_review", name: "Reviewing" }] }) });
  assert.deepEqual(await names(), ["cat_review=Reviewing", "cat_mine=Mine"]);
  // A primary reached through a peer: its list as that peer tells it.
  const first = box("mac", "Old Mac");
  receive(lab, { workQueue: telling([], { categories: [{ id: "cat_old", name: "Old" }], primary: { key: first.pub, kind: "mac", since: 500 } }) });
  assert.equal(link.primaryOf(link.readLink()).via?.key, lab.pub);
  receive(lab, { workQueue: telling([], { categories: [{ id: "cat_old", name: "Old" }], primary: { key: first.pub, kind: "mac", since: 500 } }) });
  assert.deepEqual(await names(), ["cat_old=Old", "cat_mine=Mine"]);
  sent.length = 0;
});

test("a first computer that's gone (put away, or set up again with new keys) stops being the primary once it hasn't answered for days; heard again, it's the primary again", () => {
  const file = path.join(queues, "numbers.json");
  const reach = (away, checked) => {
    write(path.join(run, "peer-reach.json"), { [mac.pub]: away });
    write(path.join(run, "peer-reach-checked.json"), { [mac.pub]: checked });
  };
  // A machine set up from two Macs: the first one set up is the primary.
  fresh({ macs: [mac, later] });
  write(file, { primary: mac.pub, leases: [] });
  write(path.join(queues, "peers", `${mac.pub}.json`), { id: "wqt_aaaaaaaaaaaa", at: 1, heard: 1, kind: "mac", since: 1_000, items: [], owners: [], categories: [] });
  write(path.join(queues, "peers", `${later.pub}.json`), { id: "wqt_bbbbbbbbbbbb", at: 1, heard: 1, kind: "mac", since: 9_000, items: [], owners: [], categories: [] });
  const now = Date.now();
  assert.equal(link.primaryOf(link.readLink(), file, now).peer.key, mac.pub);
  // It stops answering: a day, still the primary; past three, and still not there lately, the next.
  reach(now - 86_400_000, now - 60_000);
  assert.equal(link.primaryOf(link.readLink(), file, now).peer.key, mac.pub);
  reach(now - 4 * 86_400_000, now - 60_000);
  assert.equal(link.primaryOf(link.readLink(), file, now).peer.key, later.pub);
  link.notePrimaryNow(link.readLink(), { file, now });
  assert.equal(link.readNumbers(file).primary, later.pub);
  // Heard from again: the first again.
  fs.rmSync(path.join(run, "peer-reach.json"));
  assert.equal(link.primaryOf(link.readLink(), file, now).peer.key, mac.pub);
  // Away when this box itself went off the relay days ago, not found away since: not gone.
  write(file, { primary: mac.pub, leases: [] });
  reach(now - 4 * 86_400_000, now - 4 * 86_400_000);
  assert.equal(link.primaryOf(link.readLink(), file, now).peer.key, mac.pub);

  // A primary this box reaches only through lab: once lab numbers from another (it found that one
  // gone), so does this box, without waiting days of its own; while lab can't say, it waits.
  fs.rmSync(path.join(run, "peer-reach.json"));
  fresh();
  const old = box("mac", "Old Mac");
  write(path.join(queues, "peers", `${lab.pub}.json`), { id: "wqt_cccccccccccc", at: 3, heard: 3, kind: "machine", since: 10, items: [], owners: [], categories: [], primary: { key: old.pub, kind: "mac", since: 500 } });
  write(file, { primary: old.pub, through: lab.pub, leases: [] });
  assert.equal(link.primaryOf(link.readLink(), file, now).peer.key, old.pub);
  write(path.join(queues, "peers", `${lab.pub}.json`), { id: "wqt_cccccccccccc", at: 4, heard: 4, kind: "machine", since: 10, items: [], owners: [], categories: [] });
  assert.deepEqual(link.primaryOf(link.readLink(), file, now), { away: true });
  write(path.join(queues, "peers", `${lab.pub}.json`), { id: "wqt_cccccccccccc", at: 5, heard: 5, kind: "machine", since: 10, items: [], owners: [], categories: [], primary: { key: mac.pub, kind: "mac", since: 1_000 } });
  assert.equal(link.primaryOf(link.readLink(), file, now).peer.key, mac.pub);
});

test("an issue another computer told of shows as it said, with no gh here; this box reads it only once what was told is old; the newer word wins, never one from a clock set ahead", async () => {
  write(path.join(run, "work", "elsewhere", `${lab.pub}.json`), { at: Date.now(), heard: Date.now(), leads: {} });
  const issue = seen => ({ ...told(510, "ses_far", { title: "Upload retries", category: "done", keptIn: "later", seen,
    source: { kind: "github", ref: "gh:kuvo-test/app#12", url: "https://github.com/kuvo-test/app/issues/12", host: "github.com", id: "I_kw12" } }), number: undefined });
  const shown = async () => (await view("all")).items.find(item => item.source?.ref === "gh:kuvo-test/app#12");

  // Told a moment ago that it's closed (as it has been for two hours): shown so, GitHub not asked.
  receive(lab, { workQueue: telling([issue({ state: "completed", at: Date.now() - 7_200_000, checked: Date.now() - 30_000 })]) });
  let item = await shown();
  assert.deepEqual([item.category, item.keptIn, item.seen.state, item.source.name, item.computer.name], ["done", "later", "completed", "app#12", "lab"]);
  assert.equal(ghAsks(), 0, "lab reads what it shows, and told it lately");

  // A clock set ahead there: what it says is no later than when it told it.
  receive(lab, { workQueue: telling([issue({ state: "completed", at: Date.now() + 3_600_000, checked: Date.now() + 3_600_000 })]) });
  item = await shown();
  assert.ok(item.seen.at <= Date.now() && item.seen.checked <= Date.now());

  // Told long ago that it's open: read here, and GitHub's word now (reopened, then closed again) wins.
  receive(lab, { workQueue: telling([issue({ state: "open", at: Date.now() - 7_200_000, checked: Date.now() - 600_000 })]) });
  write(ghAnswer, { data: { p0: { issueOrPullRequest: { __typename: "Issue", id: "I_kw12", number: 12, title: "Upload retries drop the name", url: "https://github.com/kuvo-test/app/issues/12", state: "CLOSED", stateReason: "NOT_PLANNED", closedAt: "2026-11-10T09:00:00Z" } } } });
  item = await shown();
  assert.equal(ghAsks(), 1);
  assert.deepEqual([item.category, item.seen.state, item.struck, item.title], ["done", "not_planned", true, "Upload retries drop the name"]);

  // (This box's read a second earlier than it was: what lab tells next is surely later.)
  const seenFile = path.join(queues, "seen.json");
  const kept = read(seenFile);
  for (const each of Object.values(kept.reads)) { each.at -= 1000; if (each.checked) each.checked -= 1000; }
  write(seenFile, kept);
  // Then lab tells it asked GitHub after this box did, and it says open (as it has for two hours,
  // by lab's word): lab's, as the later word.
  receive(lab, { workQueue: telling([issue({ state: "open", at: Date.now() - 7_200_000, checked: Date.now() })]) });
  item = await shown();
  assert.deepEqual([item.category, item.seen.state, item.struck], ["later", "open", undefined]);
  assert.equal(ghAsks(), 1, "nor asked again while lab's word is fresh");
});

// ---- What you do to an item another computer keeps (PROTOCOL.md, "The Work Queue", What you do to one)

// Lab and the Mac take what you do from another box.
const forwardsTold = () => agentsTold({
  [lab.pub]: { at: 1, heard: Date.now(), kind: "machine", id: "lab", list: [], features: ["work-queue", "work-queue.elsewhere", "work-queue.forward"] },
  [mac.pub]: { at: 1, heard: Date.now(), kind: "mac", list: [], features: ["work-queue", "work-queue.elsewhere", "work-queue.forward"] },
});
// This box's relay connection as its link has it: what goes to `to`, as it's sent.
const relay = () => {
  let waiting = null;
  const connection = { welcomed: true, send: bytes => { sent.push(bytes); waiting?.(); } };
  return { connection, sentTo: async to => {
    for (;;) {
      const mails = mailTo(to);
      if (mails.length) return mails;
      await new Promise(resolve => { waiting = resolve; });
    }
  } };
};
const actID = () => `wqa_${crypto.randomBytes(16).toString("base64url")}`;
const forwards = path.join(queues, "forward");

test("what you do to an item another computer keeps, asked of this box, is done there: this box hands it to that computer's box and answers with what it said", async () => {
  forwardsTold();
  receive(lab, { workQueue: telling([told(500, "ses_far"), told(501, "ses_far", { category: "later" })]) });
  sent.length = 0;
  // This box's link sends what's left as it's left.
  const { connection, sentTo } = relay();
  link.queueForwardsSoon.send = () => link.sendQueueForwards(connection);

  // Moved: the move goes to lab, and lab's answer is this box's.
  const moving = route("POST", `kuvo/work-queue/items/500/move`, { category: "later", top: true });
  const [asked] = await sentTo(lab);
  const act = asked.workQueue.act;
  assert.deepEqual({ method: act.method, action: act.action, item: act.item, body: act.body }, { method: "POST", action: "move", item: told(500).id, body: { category: "later", top: true } });
  // (Only from the box it went to: one from the Mac for it isn't lab's answer.)
  receive(mac, { workQueue: { acted: { id: act.id, status: 200, value: { item: told(500, "ses_far", { category: "next" }) } } } });
  receive(lab, { workQueue: { acted: { id: act.id, status: 200, value: { item: told(500, "ses_far", { category: "later", order: 0 }) } } } });
  const moved = await moving;
  assert.equal(moved.status, 200);
  assert.equal(moved.body.item.category, "later", "lab's word, not the Mac's");
  assert.deepEqual(moved.body.item.computer, { key: lab.pub, name: "lab", kind: "machine", id: "lab" }, "said to be on lab, as this box names it");
  assert.deepEqual(fs.readdirSync(forwards), [], "nothing left behind");
  assert.equal((await view("all")).items.find(item => item.number === 500).category, "later", "shown where it went at once, not when lab next tells");
  // Lab tells something newer while its answer is on the way: lab's newer word stays.
  const racing = route("POST", `kuvo/work-queue/items/500/move`, { category: "next", top: true });
  const [raced] = await sentTo(lab);
  receive(lab, { workQueue: telling([told(500, "ses_far", { category: "done", updated: { at: 9000, by: { session: "ses_far", name: "Far" } } }), told(501, "ses_far", { category: "later" })]) });
  mailTo(lab);
  receive(lab, { workQueue: { acted: { id: raced.workQueue.act.id, status: 200, value: { item: told(500, "ses_far", { category: "next" }) } } } });
  assert.equal((await racing).status, 200);
  assert.equal((await view("all")).items.find(item => item.number === 500).category, "done", "never over what lab told since");

  // Refused there: lab's words, as lab said them.
  const restoring = route("POST", "kuvo/work-queue/items/501/restore");
  const [again] = await sentTo(lab);
  assert.equal(again.workQueue.act.action, "restore");
  receive(lab, { workQueue: { acted: { id: again.workQueue.act.id, status: 400, value: { message: "It isn't deleted." } } } });
  assert.deepEqual(await restoring, { status: 400, body: { message: "It isn't deleted.", computer: { key: lab.pub, name: "lab", kind: "machine", id: "lab" } } });

  // Read whole, from a client: lab's whole item, said to be read there.
  const reading = route("GET", "kuvo/work-queue/items/500");
  const [read] = await sentTo(lab);
  assert.deepEqual({ method: read.workQueue.act.method, item: read.workQueue.act.item }, { method: "GET", item: told(500).id });
  receive(lab, { workQueue: { acted: { id: read.workQueue.act.id, status: 200, value: { item: { ...told(500, "ses_far"), body: "What only lab keeps", notes: [], events: [], files: [], links: [], handed: [] } } } } });
  const whole = await reading;
  assert.equal(whole.body.item.body, "What only lab keeps");
  assert.equal(whole.body.item.told, false);
  assert.equal(whole.body.item.computer.id, "lab");
  // One of its files, for a client: from lab, its bytes as they are.
  const fetching = route("GET", "kuvo/work-queue/items/500/files/notes%20one.txt");
  const [file] = await sentTo(lab);
  assert.deepEqual({ method: file.workQueue.act.method, action: file.workQueue.act.action, name: file.workQueue.act.name }, { method: "GET", action: "file", name: "notes one.txt" });
  receive(lab, { workQueue: { acted: { id: file.workQueue.act.id, status: 200, value: { type: "text/plain", data: Buffer.from("From lab.").toString("base64") } } } });
  assert.deepEqual(await fetching, { status: 200, body: "From lab." });
  // A picture too big for one mail: in parts, put together here.
  const picture = crypto.randomBytes(120_000);
  const fetchingPicture = (async () => {
    const pieces = [];
    for await (const piece of handle({ method: "GET", path: "kuvo/work-queue/items/500/files/shot.png", headers: {}, fromApp: true }, undefined)) pieces.push(piece);
    return { status: pieces.find(each => each.head).head.status, bytes: Buffer.concat(pieces.filter(each => each.body).map(each => each.body)) };
  })();
  const [shot] = await sentTo(lab);
  const answer = { acted: { id: shot.workQueue.act.id, status: 200, value: { type: "image/png", data: picture.toString("base64") } } };
  const d = Buffer.from(JSON.stringify(answer)).toString("base64url");
  const of = Math.ceil(d.length / 40_000);
  assert.ok(of > 1);
  const digest = crypto.createHash("sha256").update(d).digest("base64url");
  for (let i = 0; i < of; i++) receive(lab, { workQueue: { part: { whole: digest, i, of, d: d.slice(i * 40_000, (i + 1) * 40_000), s: "" } } });
  const got = await fetchingPicture;
  assert.equal(got.status, 200);
  assert.ok(got.bytes.equals(picture), "its bytes as they are");
  // An answer that isn't a status is never taken.
  const odd = route("GET", "kuvo/work-queue/items/500/files/big.png");
  const [big] = await sentTo(lab);
  receive(lab, { workQueue: { acted: { id: big.workQueue.act.id, status: 1000, value: {} } } });
  receive(lab, { workQueue: { acted: { id: big.workQueue.act.id, status: 413, value: { message: "big.png is 9 MB: too big to bring from lab (4 MB at most). Open it there." } } } });
  assert.deepEqual(await odd, { status: 413, body: { message: "big.png is 9 MB: too big to bring from lab (4 MB at most). Open it there.", computer: { key: lab.pub, name: "lab", kind: "machine", id: "lab" } } });
  // Anyone else on this computer (an agent's `box route`, unproven) reads it only as lab told it.
  const pieces = [];
  for await (const piece of handle({ method: "GET", path: "kuvo/work-queue/items/500", headers: {}, fromMac: true }, undefined)) pieces.push(piece);
  const told500 = JSON.parse(Buffer.concat(pieces.filter(each => each.body).map(each => each.body)).toString());
  assert.deepEqual([told500.item.body, told500.item.told], ["", true]);
  assert.deepEqual(mailTo(lab), [], "and lab isn't asked");
  // And never changes it: only a client does.
  const refused = [];
  for await (const piece of handle({ method: "DELETE", path: "kuvo/work-queue/items/500", headers: {}, fromMac: true }, undefined)) refused.push(piece);
  assert.equal(refused.find(each => each.head).head.status, 403);
  assert.deepEqual(mailTo(lab), []);
});

test("a Mac's request over SSH (`box route`, a process with no relay connection) is left for this box's link, which sends it and leaves lab's answer for it", async () => {
  forwardsTold();
  receive(lab, { workQueue: telling([told(500, "ses_far")]) });
  sent.length = 0;
  // (And one left by something else on this computer.)
  const planted = actID();
  write(path.join(forwards, `${planted}.json`), { to: lab.pub, act: { id: planted, method: "DELETE", item: told(500).id, at: Date.now() } });
  // (`box route`: nothing in this process sends; the link, another process, sees what's left.)
  const theRoutes = () => fs.readdirSync(forwards).some(name => /^wqa_.+\.json$/.test(name) && name !== `${planted}.json` && !name.endsWith(".answer.json"));
  const left = new Promise(resolve => {
    const watch = fs.watch(forwards, () => { if (theRoutes()) { watch.close(); resolve(); } });
    if (theRoutes()) { watch.close(); resolve(); }
  });
  const deleting = route("DELETE", "kuvo/work-queue/items/500");
  await left;
  const { connection } = relay();
  // This Mac's box, whose routes run where it sends, sends only what they left: what anything else
  // on the Mac leaves there never goes out as you.
  link.sendQueueForwards(connection, undefined, undefined, { ownOnly: true });
  const [asked, ...others] = mailTo(lab);
  assert.deepEqual(others, []);
  assert.notEqual(asked.workQueue.act.id, planted);
  fs.rmSync(path.join(forwards, `${planted}.json`));
  assert.equal(asked.workQueue.act.method, "DELETE");
  // Sent again only after a few seconds while it's waited for (lab takes each id once anyway).
  link.sendQueueForwards(connection);
  assert.deepEqual(mailTo(lab), []);
  link.sendQueueForwards(connection, undefined, Date.now() + 6_000);
  assert.equal(mailTo(lab)[0].workQueue.act.id, asked.workQueue.act.id);
  receive(lab, { workQueue: { acted: { id: asked.workQueue.act.id, status: 200, value: { item: told(500, "ses_far", { removed: { at: 3000, by: { user: true } } }) } } } });
  const deleted = await deleting;
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.item.removed.by.user, true);
  assert.deepEqual(fs.readdirSync(forwards), []);
  // Gone from this box's views at once, beside Undo; and Undo still brings it back on lab once lab
  // has told without it.
  assert.equal((await view("all")).items.some(item => item.number === 500), false);
  receive(lab, { workQueue: telling([]) });
  mailTo(lab);
  const again = relay();
  link.queueForwardsSoon.send = () => link.sendQueueForwards(again.connection);
  const undoing = route("POST", `kuvo/work-queue/items/${told(500).id}/restore`);
  const [undo] = await again.sentTo(lab);
  assert.equal(undo.workQueue.act.action, "restore");
  receive(lab, { workQueue: { acted: { id: undo.workQueue.act.id, status: 200, value: { item: told(500, "ses_far") } } } });
  assert.equal((await undoing).status, 200);
  assert.equal((await view("all")).items.some(item => item.number === 500), true, "back at once");
  link.queueForwardsSoon.send = () => {};
  // One whose asker went (its process stopped mid-wait), and an answer left with no ask: cleared at
  // the link's next round, never sent.
  const stale = actID();
  write(path.join(forwards, `${stale}.json`), { to: lab.pub, act: { id: stale, method: "DELETE", item: told(500).id, at: Date.now() - 60_000 } });
  write(path.join(forwards, `${actID()}.answer.json`), { status: 200, value: {} });
  link.sendQueueForwards(connection);
  assert.deepEqual(mailTo(lab), []);
  assert.deepEqual(fs.readdirSync(forwards), []);
});

test("a computer that keeps the item but isn't answering: said at once, plainly, and nothing goes; one that doesn't take it from another box yet is changed there, as before", async () => {
  forwardsTold();
  receive(lab, { workQueue: telling([told(500, "ses_far")]) });
  sent.length = 0;
  const { connection } = relay();
  link.queueForwardsSoon.send = () => link.sendQueueForwards(connection);
  write(path.join(run, "peer-reach.json"), { [lab.pub]: Date.now() - 60_000 });
  const away = await route("DELETE", "kuvo/work-queue/items/500");
  assert.equal(away.status, 503);
  assert.match(away.body.message, /^lab isn't answering now \(it may be asleep, off or offline\), so nothing was changed there\. Try again once it's back\.$/);
  assert.equal(away.body.computer.id, "lab");
  assert.deepEqual(mailTo(lab), []);
  // Read whole: as lab last told it, and said so.
  const page = await route("GET", "kuvo/work-queue/items/500");
  assert.deepEqual([page.status, page.body.item.title, page.body.item.told], [200, "Item 500", true]);
  assert.deepEqual(mailTo(lab), []);

  // Sent, and lab stops answering before it answers: it may have been done, and it says so.
  fs.rmSync(path.join(run, "peer-reach.json"));
  const { sentTo } = relay();
  const stopping = route("POST", "kuvo/work-queue/items/500/move", { category: "later" });
  await sentTo(lab);
  write(path.join(run, "peer-reach.json"), { [lab.pub]: Date.now() });
  const stopped = await stopping;
  assert.equal(stopped.status, 503);
  assert.match(stopped.body.message, /^lab stopped answering, so devbox can't tell whether it was done there\. Look again once it's back\.$/);
  // No answer in time: the same.
  fs.rmSync(path.join(run, "peer-reach.json"));
  link.queueForwardTiming.wait = 0;
  const late = await route("DELETE", "kuvo/work-queue/items/500");
  assert.equal(late.status, 503);
  assert.match(late.body.message, /^lab didn't answer in time, so devbox can't tell whether it was done there\. Look again in a moment\.$/);
  link.queueForwardTiming.wait = 20_000;
  mailTo(lab);

  // On a machine Macs share outside one setup (another person may use it): never handed on.
  fresh({ macs: [mac, later] });
  const shared = await route("DELETE", "kuvo/work-queue/items/500");
  assert.equal(shared.status, 409);
  assert.match(shared.body.message, /#500 "Item 500" is on lab: change it there\./);
  assert.deepEqual(mailTo(lab), []);
  fresh();

  // A lab from before: changed there, as it was.
  agentsTold();
  const older = await route("POST", "kuvo/work-queue/items/500/move", { category: "later" });
  assert.equal(older.status, 409);
  assert.match(older.body.message, /#500 "Item 500" is on lab: change it there\./);
  assert.deepEqual(mailTo(lab), []);
});

test("asked by another of your computers' boxes, this box does it to the item it keeps as its own client would, answers once for each ask, and takes it only from your computers", async () => {
  write(path.join(queues, "numbers.json"), { primary: mac.pub, leases: [[100, 149]] });
  await tool("queue_add", { title: "Ship the release" }, "ses_lead");
  await tool("queue_add", { title: "Write the notes" }, "ses_lead");
  const id = (await view("ses_lead")).items.find(item => item.number === 100).id;
  sent.length = 0;
  const act = { id: actID(), method: "POST", action: "move", item: id, body: { category: "later" }, at: Date.now() };
  await takeFrom(mac, { act });
  const [answer] = mailTo(mac);
  assert.equal(answer.workQueue.acted.id, act.id);
  assert.equal(answer.workQueue.acted.status, 200);
  assert.equal(answer.workQueue.acted.value.item.category, "later");
  assert.equal((await view("ses_lead")).items.find(item => item.number === 100).category, "later", "moved here, numbers as they were");
  const moves = async () => (await route("GET", `kuvo/work-queue/items/${id}`)).body.item.events.filter(event => event.kind === "moved");
  assert.deepEqual((await moves()).map(event => [event.by, event.to]), [[{ user: true }, "later"]], "by you, in its activity");

  // The same ask again at once (sent again while it was on its way back): not answered twice in a
  // moment; nor done twice, after this box starts again (its answer lost), when it's answered as it was.
  await takeFrom(mac, { act: { ...act, body: { category: "next" } } });
  assert.deepEqual(mailTo(mac), []);
  link.forgetQueueActs();
  await takeFrom(mac, { act: { ...act, body: { category: "next" } } });
  assert.deepEqual(mailTo(mac).map(each => each.workQueue.acted), [answer.workQueue.acted]);
  assert.equal((await moves()).length, 1);
  // One that was under way as this box stopped: it can't tell whether it was done.
  const cut = { id: actID(), method: "POST", action: "move", item: id, body: { category: "next" }, at: Date.now() };
  write(path.join(queues, "acted.json"), { ...read(path.join(queues, "acted.json")), [`${mac.pub} ${cut.id}`]: { until: Date.now() + 600_000, answer: null } });
  await takeFrom(mac, { act: cut });
  assert.deepEqual(mailTo(mac)[0].workQueue.acted, { id: cut.id, status: 409, value: { message: "devbox stopped while it was doing this, so it can't tell whether it was done. Look again in a moment." } });
  assert.equal((await moves()).length, 1);

  // A file kept with it: its bytes, for the box that asked; one that isn't there, 404.
  const files = path.join(queues, "files", id);
  write(path.join(files, "plan.txt"), "The plan.");
  const book = read(path.join(queues, "queues", "ses_lead.json"));
  book.items.find(item => item.id === id).files = [{ name: "plan.txt", size: 9, type: "text/plain", at: 1 }];
  write(path.join(queues, "queues", "ses_lead.json"), book);
  await takeFrom(lab, { act: { id: actID(), method: "GET", action: "file", name: "plan.txt", item: id, at: Date.now() } });
  const [bytes] = mailTo(lab);
  assert.deepEqual([bytes.workQueue.acted.status, bytes.workQueue.acted.value.type, Buffer.from(bytes.workQueue.acted.value.data, "base64").toString()], [200, "text/plain", "The plan."]);
  await takeFrom(lab, { act: { id: actID(), method: "GET", action: "file", name: "none.txt", item: id, at: Date.now() } });
  assert.equal(mailTo(lab)[0].workQueue.acted.status, 404);

  // Read whole, deleted, and refused as the route would.
  const readAsk = { id: actID(), method: "GET", item: "100", at: Date.now() };
  await takeFrom(lab, { act: readAsk });
  const [whole] = mailTo(lab);
  assert.deepEqual([whole.workQueue.acted.status, whole.workQueue.acted.value.item.title, whole.workQueue.acted.value.item.computer], [200, "Ship the release", undefined]);
  await takeFrom(lab, { act: { id: actID(), method: "DELETE", item: id, at: Date.now() } });
  assert.equal(mailTo(lab)[0].workQueue.acted.status, 200);
  const twice = { id: actID(), method: "DELETE", item: id, at: Date.now() };
  await takeFrom(lab, { act: twice });
  assert.deepEqual(mailTo(lab)[0].workQueue.acted, { id: twice.id, status: 400, value: { message: "It's deleted already." } });
  const deleted = async () => (await view("all")).removed.some(item => item.id === id);
  // One from long ago (sent again, or a clock far off): not done.
  const old = { id: actID(), method: "POST", action: "restore", item: id, at: Date.now() - 3_600_000 };
  await takeFrom(lab, { act: old });
  assert.equal(mailTo(lab)[0].workQueue.acted.status, 409);
  assert.equal(await deleted(), true);
  // An ask dated ahead of this clock by more than a minute: refused, as one long ago is. One a little
  // ahead is remembered until it would be too old to take, so it's never taken twice.
  const ahead = { id: actID(), method: "POST", action: "restore", item: id, at: Date.now() + 5 * 60_000 };
  await takeFrom(mac, { act: ahead });
  assert.equal(mailTo(mac)[0].workQueue.acted.status, 409);
  assert.equal(await deleted(), true);
  const doneFor = act => link.queueActForPeer(act, targets);
  const answers = [];
  const start = Date.now();
  const soon = { id: actID(), method: "POST", action: "restore", item: id, at: start + 50_000 };
  await link.takeQueueAct(mac.peer, soon, payload => answers.push(payload.acted), doneFor, start);
  assert.equal(answers[0].status, 200);
  await link.takeQueueAct(mac.peer, { id: actID(), method: "DELETE", item: id, at: start }, payload => answers.push(payload.acted), doneFor, start);
  assert.equal(await deleted(), true);
  link.forgetQueueActs();
  await link.takeQueueAct(mac.peer, soon, payload => answers.push(payload.acted), doneFor, start + 630_000);
  assert.deepEqual(answers.at(-1), answers[0], "answered as it was, not brought back again");
  assert.equal(await deleted(), true);

  // One it knows only as a third computer told it: no longer here, and never handed on (no loops).
  receive(lab, { workQueue: telling([told(500, "ses_far")]) });
  sent.length = 0;
  await takeFrom(mac, { act: { id: actID(), method: "DELETE", item: told(500).id, at: Date.now() } });
  const [noLonger] = mailTo(mac);
  assert.deepEqual([noLonger.workQueue.acted.status, noLonger.workQueue.acted.value], [404, { message: "It's no longer on devbox: it may have moved. Look again in a moment." }]);
  assert.deepEqual(mailTo(lab), [], "nothing sent on to lab");

  // From a machine Macs share outside one setup (another person may use it): refused.
  receive(lab, { workQueue: telling([], { shared: true }) });
  sent.length = 0;
  await takeFrom(lab, { act: { id: actID(), method: "POST", action: "restore", item: id, at: Date.now() } });
  assert.deepEqual(mailTo(lab)[0].workQueue.acted.value, { message: "devbox doesn't take changes from lab, a machine shared with other Macs: change it from devbox." });
  assert.equal(await deleted(), true);
  // From a box that isn't one of your computers: nothing at all.
  const stranger = box("machine", "stranger");
  await link.takeWorkQueueMail(stranger.peer, { act: { id: actID(), method: "POST", action: "restore", item: id, at: Date.now() } }, host, places);
  assert.deepEqual(sent, []);
  assert.equal(await deleted(), true);
});

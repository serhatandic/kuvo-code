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
  fs.rmSync(run, { recursive: true, force: true });
  fs.mkdirSync(run, { recursive: true });
  write(path.join(run, "engine.json"), { ...target, version: "0.0.0" });
  sent.length = 0;
  calling.clear();
  link.tellQueuesAgain();
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

  // What lab told before is had, but kept no more than what it told since.
  const older = telling([told(503, "ses_far")], { at: Date.now() - 3_600_000 });
  receive(lab, { workQueue: older });
  assert.deepEqual(mailTo(lab).map(each => each.workQueue), [{ had: older.told.id }]);
  assert.equal((await view("all")).items.some(item => item.number === 503), false);
  // A box that isn't one of your computers isn't heard at all.
  const stranger = box("machine", "stranger");
  link.receiveMail(link.sealOneWay(Buffer.from(JSON.stringify({ workQueue: telling([told(600, "ses_x")]), at: Date.now() })), stranger.key, link.publicOf(here.key)).message, host, (sender, given) => link.peerMail(sender, given, host, places));
  assert.equal((await view("all")).items.some(item => item.number === 600), false);
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
  // Never back to the later one, whatever it says next.
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

  // One lab can't take comes back as it was, with why.
  await tool("queue_add", { title: "Second" }, "ses_lead");
  await tool("queue_hand", { item: "#101", to: "Wren" }, "ses_lead");
  await link.pushQueues(host, link.readLink(), targets, now + 200_000);
  const second = mailTo(lab).map(each => each.workQueue).find(each => each.hand)?.hand;
  assert.equal(second.to, "ses_wren", "a bot on lab, by its name");
  receive(lab, { workQueue: { handed: { id: second.id, ok: false, why: "That queue has 2,000 open items already." } } });
  const back = await tool("queue_show", { item: 101 }, "ses_lead");
  assert.match(back.text, /Couldn't be handed to Wren on another computer: That queue has 2,000 open items already\. It's still here\./);
  assert.equal((await tool("queue_update", { item: 101, note: "ok" }, "ses_lead")).isError, false);

  // To a computer that runs an older Kuvo Code: refused, saying so.
  agentsTold({ [lab.pub]: { at: 1, heard: Date.now(), kind: "machine", id: "lab", list: [{ session: "ses_far", name: "Far", kind: "session" }], features: ["work-queue"] } });
  const older = await tool("queue_hand", { item: 101, to: "ses_far" }, "ses_lead");
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
  // For no conversation here.
  await takeFrom(lab, { hand: { ...hand, id: "wqh_fromlab00000002", to: "ses_nobody", item: { ...item, id: "wqi_handedfromlab0000002" } } });
  const refused = mailTo(lab).map(each => each.workQueue.handed);
  assert.equal(refused[0].ok, false);
  assert.match(refused[0].why, /There's no conversation ses_nobody on /);
});

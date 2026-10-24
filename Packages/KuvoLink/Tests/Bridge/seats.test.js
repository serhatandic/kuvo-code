// Group chats across your computers (PROTOCOL.md, "Peers": `seat`): the link carries the coding
// agents' bridge's mail between computers, now or until it's there, in parts when it's big, and
// tells the bridge who your other computers and their bots are. Run with
// `node --test Packages/KuvoLink/Tests/Bridge/*.test.js`.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-seats-"));
process.env.KUVO_HOME = home;
after(() => fs.rmSync(home, { recursive: true, force: true }));
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");

const run = path.join(home, "run");
const k = key => key.toString("base64url");
const box = (kind, id) => {
  const key = link.newKey();
  const address = k(link.addressOf(crypto.randomBytes(32)));
  return { key, pub: k(link.publicOf(key)), address, peer: { key: k(link.publicOf(key)), address, name: id ?? kind, kind, ...(id ? { id } : {}) } };
};
const here = box("machine", "lokum"), mac = box("mac"), second = box("machine", "second");
const fresh = () => {
  fs.rmSync(run, { recursive: true, force: true });
  fs.mkdirSync(run, { recursive: true });
  link.writeLink({ secret: crypto.randomBytes(32).toString("base64url"), key: k(here.key), relay: "wss://relay.test", name: "lokum", id: "lokum", mac: mac.pub, macs: [mac.pub], phones: [], peersFrom: { [mac.pub]: { at: 1, peers: [mac.peer, second.peer] } } });
};
const opened = (bytes, to) => {
  const body = link.readFrame(bytes.subarray(17)).body;
  return { address: k(bytes.subarray(1, 17)), payload: JSON.parse(link.openOneWay(body, to.key, link.publicOf(here.key)).payload.toString("utf8")) };
};
// The bridge, as the link asks it: what it was handed, and whether it takes it now.
const bridge = (takes = true) => {
  const asked = [];
  return { asked, ask: async (method, route, body) => {
    asked.push({ method, route, body });
    if (!takes) throw new Error("It isn't running.");
    return { ok: true };
  } };
};

test("a group chat's mail that came goes to the bridge; one that mustn't be lost is said to have come once the bridge has it, or to come again later", async () => {
  fresh();
  const said = [];
  const send = (to, message) => said.push({ to: to.key, message });
  const now = bridge();
  await link.takeSeat(second.peer, { seat: { kind: "turn", turn: { id: "trn_1" } } }, send, now.ask);
  assert.deepEqual(now.asked, [{ method: "POST", route: "/mail", body: { from: second.pub, mail: { kind: "turn", turn: { id: "trn_1" } } } }]);
  assert.deepEqual(said, [], "one that goes now isn't said to have come");

  await link.takeSeat(second.peer, { seat: { kind: "work", work: { task: "gt_1" } }, seatID: "sm_work0001" }, send, now.ask);
  assert.deepEqual(said, [{ to: second.pub, message: { delivered: { id: "sm_work0001", ok: true } } }]);
  // The bridge not running now: it comes again, from the box that sent it.
  const down = bridge(false);
  await link.takeSeat(second.peer, { seat: { kind: "work", work: { task: "gt_2" } }, seatID: "sm_work0002" }, send, down.ask);
  assert.deepEqual(said.at(-1), { to: second.pub, message: { delivered: { id: "sm_work0002", ok: false, why: "Not now.", retry: true } } });
});

test("a big one (the whole chat, for a seat new to it) goes in parts, and is put together where it goes, in any order, once", async () => {
  fresh();
  const mail = { kind: "turn", turn: { id: "trn_big", text: "é".repeat(150_000) } };
  const payloads = link.seatPayloads(mail, "sm_bigone001");
  assert.ok(payloads.length >= 4, `${payloads.length} parts`);
  assert.ok(payloads.every(payload => payload.seatPart && JSON.stringify(payload).length < 64_000), "each fits in a mail");
  const said = [];
  const taken = bridge();
  for (const payload of [...payloads].reverse()) await link.takeSeat(second.peer, payload, (to, message) => said.push(message), taken.ask);
  assert.equal(taken.asked.length, 1);
  assert.deepEqual(taken.asked[0].body.mail, mail);
  assert.deepEqual(said, [{ delivered: { id: "sm_bigone001", ok: true } }]);
  // Parts another box sent don't make up this one's.
  const mixed = bridge();
  await link.takeSeat(mac.peer, payloads[0], () => {}, mixed.ask);
  for (const payload of payloads.slice(1)) await link.takeSeat(second.peer, payload, () => {}, mixed.ask);
  assert.equal(mixed.asked.length, 0);
  // A small one goes whole.
  assert.deepEqual(link.seatPayloads({ kind: "stop", id: "trn_1" }), [{ seat: { kind: "stop", id: "trn_1" } }]);
});

test("who can be in a chat here from your other computers: each peer, taking a chat's turns only when it says so (groups.seats), and the bots it told of, by id", () => {
  fresh();
  link.takeAgents(second.peer, { at: 2, features: ["groups", "groups.seats"], list: [{ session: "ses_far", name: "Far", kind: "bot", id: "bot_far", about: "Watches CI" }, { session: "ses_s", name: "A session", kind: "session", id: "bot_not" }] });
  link.takeAgents(mac.peer, { at: 2, list: [{ session: "ses_m", name: "Mac bot", kind: "bot", id: "bot_mac" }] });
  const peers = link.seatPeers(link.readLink());
  assert.deepEqual(peers.boxes, [{ key: mac.pub, name: "mac", seats: false }, { key: second.pub, name: "second", seats: true }]);
  assert.deepEqual(peers.bots, [
    { id: "bot_mac", name: "Mac bot", job: "", box: mac.pub, session: "ses_m" },
    { id: "bot_far", name: "Far", job: "Watches CI", box: second.pub, session: "ses_far" },
  ]);
  assert.ok(link.FEATURES.includes("groups.seats"), "this box takes them");
});

test("what mustn't be lost goes to its computer only, each minute until it says it has it, and never through the Mac", () => {
  fresh();
  const sending = path.join(run, "outbox", "sending");
  fs.mkdirSync(sending, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(sending, "sm_report001.json"), JSON.stringify({ peer: second.pub, seat: { kind: "report", task: "gt_1", wrapUp: "gm_1", chat: "grp_1", result: { ok: true, text: "Done.", steps: [] } }, at: now }));
  const sent = [];
  const host = { send: bytes => sent.push(bytes) };
  link.sendOutbox(host, link.readLink(), now);
  assert.equal(sent.length, 1);
  const { address, payload } = opened(sent[0], second);
  assert.equal(address, second.address);
  assert.deepEqual([payload.seat.kind, payload.seatID], ["report", "sm_report001"]);
  link.sendOutbox(host, link.readLink(), now + 3000);
  assert.equal(sent.length, 1, "not again within the minute");
  link.sendOutbox(host, link.readLink(), now + 64_000);
  assert.equal(sent.length, 2, "again after a minute");
  // No relay for a long while: it waits for it, rather than going to the Mac over SSH.
  link.sendOutbox(host, link.readLink(), now + 130_000, 10 * 60_000);
  assert.ok(fs.existsSync(path.join(sending, "sm_report001.json")));
  assert.equal(fs.readdirSync(path.join(run, "outbox")).filter(name => name.endsWith(".json")).length, 0);
  // Only the computer it went to says it has it.
  link.letterWent(mac.peer, { id: "sm_report001", ok: true });
  assert.ok(fs.existsSync(path.join(sending, "sm_report001.json")));
  link.letterWent(second.peer, { id: "sm_report001", ok: true });
  assert.equal(fs.existsSync(path.join(sending, "sm_report001.json")), false);
});

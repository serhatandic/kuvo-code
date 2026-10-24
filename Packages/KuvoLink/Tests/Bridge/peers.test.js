// Your other computers (PROTOCOL.md, "Peers"): who they are, their agents, and letters between
// them, by mail through the relay. Run with `node --test Packages/KuvoLink/Tests/Bridge/*.test.js`.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// The bridge keeps its state in KUVO_HOME, so give it a folder of its own before loading it.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-peers-"));
process.env.KUVO_HOME = home;
after(() => fs.rmSync(home, { recursive: true, force: true }));
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");

const run = path.join(home, "run");
const k = key => key.toString("base64url");
// A box: its key, and how a Mac lists it.
const box = (kind, id) => {
  const key = link.newKey();
  const address = k(link.addressOf(crypto.randomBytes(32)));
  return { key, pub: k(link.publicOf(key)), address, peer: { key: k(link.publicOf(key)), address, name: id ?? kind, kind, ...(id ? { id } : {}) } };
};
const here = box("machine", "lokum"), mac = box("mac"), second = box("machine", "second"), stranger = box("machine", "stranger");
const fresh = (extra = {}) => {
  fs.rmSync(run, { recursive: true, force: true });
  fs.mkdirSync(run, { recursive: true });
  link.writeLink({ secret: crypto.randomBytes(32).toString("base64url"), key: k(here.key), relay: "wss://relay.test", name: "lokum", id: "lokum", mac: mac.pub, macs: [mac.pub], phones: [], ...extra });
};
// Mail as the host hands it on (a mail frame's body), from `from` to this box.
const mailFrom = (from, payload) => link.sealOneWay(Buffer.from(JSON.stringify(payload)), from.key, link.publicOf(here.key)).message;
// What this box sent through the relay: to whom, and what it said (opened as `to` would).
const opened = (bytes, to) => {
  const relayed = { address: k(bytes.subarray(1, 17)), payload: bytes.subarray(17) };
  const body = link.readFrame(relayed.payload).body;
  return { address: relayed.address, payload: JSON.parse(link.openOneWay(body, to.key, link.publicOf(here.key)).payload.toString("utf8")) };
};

test("a Mac that signs no documents yet (Kuvo Code 0.8.0-beta.1): its peers come in its mail, a newer list by its own clock replacing its last; this box left out, and no one else's list taken", () => {
  fresh();
  link.receiveMail(mailFrom(mac, { at: 10, peers: [mac.peer, second.peer, here.peer, { key: "bad", address: "bad", kind: "machine" }] }));
  assert.deepEqual(link.peersOf(link.readLink()).map(peer => peer.name), ["mac", "second"]);
  link.receiveMail(mailFrom(mac, { at: 5, peers: [mac.peer] }));
  assert.deepEqual(link.peersOf(link.readLink()).map(peer => peer.name), ["mac", "second"], "an older list changes nothing");
  // A peer, and anyone else, can't say who the peers are.
  link.receiveMail(mailFrom(second, { at: 20, peers: [stranger.peer] }));
  link.receiveMail(mailFrom(stranger, { at: 20, peers: [stranger.peer] }));
  assert.deepEqual(link.peersOf(link.readLink()).map(peer => peer.name), ["mac", "second"]);
  // The Mac removed `second`: it goes.
  link.receiveMail(mailFrom(mac, { at: 30, peers: [mac.peer] }));
  assert.deepEqual(link.peersOf(link.readLink()).map(peer => peer.name), ["mac"]);
  // Mail from a box that's no longer a peer isn't opened.
  const heard = [];
  link.receiveMail(mailFrom(second, { agents: { at: 1, list: [] } }), undefined, sender => heard.push(sender.key));
  link.receiveMail(mailFrom(mac, { agents: { at: 1, list: [] } }), undefined, sender => heard.push(sender.key));
  assert.deepEqual(heard, [mac.pub]);
});

test("each box's agents: a newer list kept, and list_agents here names each by where it is", () => {
  fresh();
  const file = path.join(run, "told.json"), lock = path.join(run, ".told.lock");
  const agent = (session, name, extra = {}) => ({ session, name, kind: "session", ...extra });
  assert.equal(link.takeAgents(second.peer, { at: 5, list: [agent("ses_b1", "API"), { session: "not-a-session", name: "x", kind: "session" }] }, file, lock), true);
  assert.equal(link.takeAgents(second.peer, { at: 4, list: [] }, file, lock), false, "an older list isn't taken");
  assert.equal(link.takeAgents(mac.peer, { at: 1, list: [agent("ses_m1", "Release", { kind: "bot" }), agent("ses_o1", "Old one", { machine: "old" }), agent("ses_b1", "Again")] }, file, lock), true);
  const told = link.readPeerAgents(file);
  assert.deepEqual(told[second.pub].list.map(each => each.session), ["ses_b1"]);
  const composed = link.composeAgents([agent("ses_h1", "Here")], "lokum", [second.peer, mac.peer], told);
  assert.deepEqual(composed, {
    machine: "lokum",
    agents: [
      { session: "ses_h1", name: "Here", kind: "session", machine: "lokum" },
      { session: "ses_m1", name: "Release", kind: "bot" },
      { session: "ses_o1", name: "Old one", kind: "session", machine: "old" },
      // Listed by the Mac and a machine: the Mac's word.
      { session: "ses_b1", name: "Again", kind: "session" },
    ],
  });
  assert.equal(link.peerOf("ses_o1", [second.peer, mac.peer], told)?.name, "mac", "one a Mac speaks for goes through it");
  assert.equal(link.composeAgents([], "lokum", [second.peer], told).agents.find(each => each.session === "ses_b1")?.machine, "second");
  assert.equal(link.peerOf("ses_nobody", [second.peer, mac.peer], told), null);

  // One machine claiming another's session: neither's, so letters for it go nowhere, and it isn't listed.
  assert.equal(link.takeAgents(stranger.peer, { at: 1, list: [agent("ses_b1", "Not API")] }, file, lock), true);
  const claimed = link.readPeerAgents(file);
  assert.equal(link.peerOf("ses_b1", [second.peer, stranger.peer, mac.peer], claimed)?.name, "mac", "the Mac lists it too: the Mac's word");
  assert.equal(link.takeAgents(stranger.peer, { at: 2, list: [agent("ses_b2", "Claimed")] }, file, lock), true);
  assert.equal(link.takeAgents(second.peer, { at: 6, list: [agent("ses_b2", "Mine")] }, file, lock), true);
  const both = link.readPeerAgents(file);
  assert.equal(link.peerOf("ses_b2", [second.peer, stranger.peer], both), null);
  assert.equal(link.composeAgents([], "lokum", [second.peer, stranger.peer], both).agents.some(each => each.session === "ses_b2"), false);

  // The Mac's list over SSH, for when the relay can't be reached: taken when it's newer than its mail.
  const macFile = path.join(run, "mac.json");
  fs.writeFileSync(macFile, JSON.stringify({ key: mac.pub, at: 2, list: [agent("ses_m2", "Over SSH")] }));
  assert.deepEqual(link.readPeerAgents(file, macFile, link.readLink())[mac.pub].list.map(each => each.name), ["Over SSH"]);
  fs.writeFileSync(macFile, JSON.stringify({ key: stranger.pub, at: 9, list: [agent("ses_x", "Not a Mac")] }));
  assert.equal(link.readPeerAgents(file, macFile, link.readLink())[stranger.pub].list[0].name, "Claimed", "only a Mac's");
});

// An engine with one session, for letters to reach: its prompts, and an answer once it's done.
async function engine(t) {
  const prompts = [];
  let busy = 0;
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", chunk => body += chunk);
    request.on("end", () => {
      const json = value => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      if (request.headers.authorization !== `Basic ${Buffer.from("opencode:pw").toString("base64")}`) { response.writeHead(401); return response.end(); }
      if (request.url.startsWith("/api/session?")) return json({ data: [] });
      if (request.url === "/api/session/ses_target") return json({ data: { id: "ses_target" } });
      if (request.url === "/api/session/ses_child") return json({ data: { id: "ses_child", parentID: "ses_target" } });
      // Archived, as a Mac (or a phone) archives one.
      if (request.url === "/api/session/ses_archived") return json({ data: { id: "ses_archived", metadata: { "kuvo.archived": true } } });
      if (request.url === "/api/session/ses_mine") return json({ data: { id: "ses_mine" } });
      if (request.url === "/api/session/ses_target/prompt" && request.method === "POST") {
        prompts.push(JSON.parse(body));
        busy = 1;
        return json({});
      }
      if (request.url === "/api/session/active") return json({ data: busy-- > 0 ? ["ses_target"] : [] });
      if (request.url.startsWith("/api/session/ses_target/message")) {
        const last = prompts.at(-1);
        return json({ data: last ? [{ type: "assistant", id: last.id + "z", content: [{ type: "text", text: "On it." }] }] : [] });
      }
      response.writeHead(404);
      response.end();
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { prompts, target: { port: server.address().port, password: "pw" } };
}

test("a letter from a peer: delivered once, said to be there, by its sender's own name; one it can't verify comes from an agent there, with no way back; with wait, answered by a letter", async t => {
  fresh();
  const { prompts, target } = await engine(t);
  const peers = [mac.peer, second.peer, stranger.peer];
  const told = { [second.pub]: { at: 1, list: [{ session: "ses_sender", name: "API", kind: "session" }] } };
  const said = [], answers = [];
  const take = (from, letter, extra = {}) => link.takeLetter(from, letter, { send: (peer, message) => said.push({ to: peer.key, ...message }), targets: [target],
    answer: each => answers.push(each), told, peers, wait: 10, ...extra });
  const letter = extra => ({ id: "ltr_" + crypto.randomBytes(6).toString("hex"), from: "ses_sender", to: "ses_target", text: "Can you check the build?", at: Date.now(), ...extra });

  await take(second.peer, letter({ at: Date.now() - 2 * 86_400_000 }));
  await take(second.peer, letter({ to: "ses_not_here" }));
  await take(second.peer, letter({ to: "ses_child" }));
  await take(second.peer, letter({ to: "ses_archived" }));
  assert.deepEqual(said.map(each => [each.delivered.ok, each.delivered.retry]), [[false, undefined], [false, undefined], [false, undefined], [false, undefined]]);
  assert.equal(said[2].delivered.why, "That conversation doesn't take messages.", "a subagent's");
  assert.equal(said[3].delivered.why, "That conversation doesn't take messages.", "one put away");
  assert.equal(prompts.length, 0);

  // Its sender as that box named it, waiting: delivered, said to be there, answered by a letter back.
  said.length = 0;
  const waiting = letter({ wait: true, name: "The user" });
  await take(second.peer, waiting);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].text, link.composeLetter("API", "ses_sender", "Can you check the build?", true), "the name that box gave its agent, not the letter's");
  assert.deepEqual(said, [{ to: second.pub, delivered: { id: waiting.id, ok: true } }]);
  assert.deepEqual(answers, [{ from: "ses_target", to: "ses_sender", text: "On it.", answers: waiting.id, peer: second.pub }]);

  // Again (the relay replayed it, or its ack was lost): there already, not delivered twice.
  said.length = 0;
  await take(second.peer, waiting);
  assert.equal(prompts.length, 1);
  assert.deepEqual(said, [{ to: second.pub, delivered: { id: waiting.id, ok: true } }]);

  // From something there that isn't one of its listed agents (a new session, say), or naming
  // another box's agent: an agent on that box, with no address to answer; one waiting hears no
  // answer's coming.
  said.length = 0;
  const unlisted = letter({ from: "ses_unlisted", wait: true });
  await take(second.peer, unlisted);
  assert.equal(prompts.at(-1).text, link.composeLetter("an agent on second", "unknown", "Can you check the build?", false));
  assert.deepEqual(said, [{ to: second.pub, delivered: { id: unlisted.id, ok: true, answer: false, why: "Its answer can't come back to you: it doesn't know who you are." } }]);
  await take(stranger.peer, letter());
  assert.equal(prompts.at(-1).text, link.composeLetter("an agent on stranger", "unknown", "Can you check the build?", false), "the sender is second's, not stranger's");
  assert.match(prompts.at(-1).text, /It can't be answered/);
  // One of this box's own, claimed from there: not taken for it.
  await take(second.peer, letter({ from: "ses_mine" }), { told: { [second.pub]: { at: 1, list: [{ session: "ses_mine", name: "Reviewer", kind: "session" }] } } });
  assert.equal(prompts.at(-1).text, link.composeLetter("an agent on second", "unknown", "Can you check the build?", false));
  // A Mac moved ses_sender to stranger: stranger's word now, second's list stale.
  await take(stranger.peer, letter(), { moved: new Map([["ses_sender", stranger.pub]]), told: { [second.pub]: told[second.pub], [stranger.pub]: { at: 2, list: [{ session: "ses_sender", name: "API, moved", kind: "session" }] } } });
  assert.equal(prompts.at(-1).text, link.composeLetter("API, moved", "ses_sender", "Can you check the build?", false));

  // The engine restarting: not delivered, to try again, and not taken for seen.
  said.length = 0;
  const later = letter();
  await take(second.peer, later, { targets: [{ port: 9, password: "pw" }] });
  assert.deepEqual([said[0].delivered.ok, said[0].delivered.retry], [false, true]);
  await take(second.peer, later);
  assert.equal(prompts.at(-1).text, link.composeLetter("API", "ses_sender", "Can you check the build?", false), "delivered when it comes again");

  // A few at a time from each box: the rest to try again later.
  said.length = 0;
  for (let i = 0; i < 18; i++) await take(second.peer, letter());
  assert.equal(said.filter(each => each.delivered.ok).length, 13, "twenty in ten minutes, the seven before counted");
  assert.equal(said.at(-1).delivered.retry, true);
});

test("this box's letters go to the box their agent is on, again each minute until it says it has them, cut to fit; only that box's word counts; an answer goes to the tool waiting, or as a message once it gave up", async () => {
  fresh({ peersFrom: { [mac.pub]: { at: 1, peers: [mac.peer, second.peer] } } });
  fs.writeFileSync(path.join(run, "peer-agents.json"), JSON.stringify({ [second.pub]: { at: 1, kind: "machine", list: [{ session: "ses_target", name: "API", kind: "session" }] } }));
  const sending = path.join(run, "outbox", "sending");
  fs.mkdirSync(sending, { recursive: true });
  const now = Date.now();
  const write = (id, letter) => fs.writeFileSync(path.join(sending, `${id}.json`), JSON.stringify({ from: "ses_here", name: "Here", at: now, ...letter }));
  write("ltr_waits", { to: "ses_target", text: "é".repeat(40_000), wait: true });
  write("ltr_nobody", { to: "ses_unknown", text: "Hello", wait: true });
  // One left for the Mac (in the outbox itself) isn't this link's.
  fs.writeFileSync(path.join(run, "outbox", "msg_mac.json"), JSON.stringify({ from: "ses_here", to: "ses_target", text: "Hi" }));
  const sent = [];
  const host = { send: bytes => sent.push(bytes) };

  link.sendOutbox(host, link.readLink(), now);
  assert.equal(sent.length, 0, "its sender is told of to that box first");
  link.sendOutbox(host, link.readLink(), now + 3000);
  assert.equal(sent.length, 1);
  const { address, payload } = opened(sent[0], second);
  assert.equal(address, second.address);
  assert.equal(payload.letter.id, "ltr_waits");
  assert.equal(payload.letter.wait, true);
  assert.ok(payload.letter.text.length > 0 && Buffer.byteLength(payload.letter.text) <= 24_000 && "é".repeat(40_000).startsWith(payload.letter.text), "its words cut to fit, whole characters");
  assert.ok(sent[0].length <= 65_600 + 17);
  assert.equal(fs.existsSync(path.join(run, "replies", "ltr_nobody.json")), false, "no box lists its agent now: it waits");
  assert.ok(fs.existsSync(path.join(sending, "ltr_nobody.json")));
  assert.ok(fs.existsSync(path.join(run, "outbox", "msg_mac.json")));

  link.sendOutbox(host, link.readLink(), now + 4000);
  assert.equal(sent.length, 1, "not again within the minute");
  link.sendOutbox(host, link.readLink(), now + 64_000);
  assert.equal(sent.length, 2, "again after a minute");
  // Not now (its engine restarting): kept, and tried again.
  link.letterWent(second.peer, { id: "ltr_waits", ok: false, why: "It answered 503.", retry: true });
  link.sendOutbox(host, link.readLink(), now + 125_000);
  assert.equal(sent.length, 3);

  // How it went: only from the box it went to.
  link.letterWent(stranger.peer, { id: "ltr_waits", ok: true });
  link.letterWent(mac.peer, { id: "ltr_waits", ok: false, why: "No." });
  assert.ok(fs.existsSync(path.join(sending, "ltr_waits.json")));
  link.letterWent(second.peer, { id: "ltr_waits", ok: true });
  assert.equal(fs.existsSync(path.join(sending, "ltr_waits.json")), false);
  assert.ok(fs.existsSync(path.join(run, "replies", "ltr_waits.wait")), "its answer awaited");
  link.sendOutbox(host, link.readLink(), now + 200_000);
  assert.equal(sent.length, 3, "there: not sent again");

  // Its answer, a letter from that box: to the waiting tool (from anyone else, not).
  const said = [];
  const answer = (from, extra = {}) => link.takeLetter(from, { id: "ltr_" + crypto.randomBytes(6).toString("hex"), from: "ses_target", to: "ses_here", text: "Done.", at: now, answers: "ltr_waits", ...extra },
    { send: (peer, message) => said.push(message), targets: [], told: link.readPeerAgents(), peers: link.peersOf(link.readLink()), now });
  await answer(stranger.peer);
  assert.equal(fs.existsSync(path.join(run, "replies", "ltr_waits.json")), false);
  // The tool still waiting (it notes so as it looks).
  fs.writeFileSync(path.join(run, "replies", "ltr_waits.alive"), "");
  await answer(second.peer);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(run, "replies", "ltr_waits.json"), "utf8")), { text: "Done." });
  assert.equal(fs.existsSync(path.join(run, "replies", "ltr_waits.wait")), false);
  assert.equal(said.at(-1).delivered.ok, true);

  // A tool that ended without saying so (its engine restarted): its answer isn't left for nobody,
  // it's delivered as a message (here, to try again: no engine in this test).
  write("ltr_orphan", { to: "ses_target", text: "Hi", wait: true, sentTo: second.pub });
  link.letterWent(second.peer, { id: "ltr_orphan", ok: true });
  const stale = new Date(now - 60_000);
  fs.writeFileSync(path.join(run, "replies", "ltr_orphan.alive"), "");
  fs.utimesSync(path.join(run, "replies", "ltr_orphan.alive"), stale, stale);
  said.length = 0;
  await answer(second.peer, { answers: "ltr_orphan" });
  assert.equal(fs.existsSync(path.join(run, "replies", "ltr_orphan.json")), false);
  assert.equal(said.at(-1).delivered.retry, true);

  // A tool that gave up waiting: its letter goes on without waiting.
  write("ltr_slow", { to: "ses_target", text: "Hi", wait: true });
  fs.writeFileSync(path.join(run, "replies", "ltr_slow.gaveup"), "");
  link.sendOutbox(host, link.readLink(), now + 300_000);
  link.sendOutbox(host, link.readLink(), now + 303_000);
  assert.equal(opened(sent.at(-1), second).payload.letter.id, "ltr_slow");
  assert.equal(opened(sent.at(-1), second).payload.letter.wait, false);
  assert.equal(fs.existsSync(path.join(run, "replies", "ltr_slow.gaveup")), false);

  // There, but no answer's coming: the waiting tool hears why.
  write("ltr_noanswer", { to: "ses_target", text: "Hi", wait: true, sentTo: second.pub });
  link.letterWent(second.peer, { id: "ltr_noanswer", ok: true, answer: false, why: "Its machine is away." });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(run, "replies", "ltr_noanswer.json"), "utf8")), { note: "Its machine is away." });

  // One not there in two days goes, its tool told.
  write("ltr_old", { to: "ses_target", text: "Hi", wait: true, at: now - 3 * 86_400_000 });
  link.sendOutbox(host, link.readLink(), now);
  assert.equal(fs.existsSync(path.join(sending, "ltr_old.json")), false);

  // No relay for a while: letters not yet sent go to the Mac, which takes them on over SSH; its
  // tool hears so. One already sent stays (it may have got there).
  write("ltr_stuck", { to: "ses_target", text: "Hi", wait: true });
  const before = sent.length;
  link.sendOutbox(host, link.readLink(), now + 400_000, 6 * 60_000);
  assert.equal(sent.length, before);
  assert.equal(fs.existsSync(path.join(sending, "ltr_stuck.json")), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(run, "outbox", "ltr_stuck.json"), "utf8")).wait, false);
  assert.match(JSON.parse(fs.readFileSync(path.join(run, "replies", "ltr_stuck.json"), "utf8")).note, /through your Mac/);
  assert.ok(fs.existsSync(path.join(sending, "ltr_slow.json")), "sent already: it stays for the relay");

  // The relay back, and the Mac not here since: it comes back to this link. One the Mac took
  // (`.mac-…`) stays the Mac's.
  fs.renameSync(path.join(run, "outbox", "msg_mac.json"), path.join(run, "outbox", ".mac-msg_mac.json"));
  link.sendOutbox(host, link.readLink(), now + 500_000);
  assert.ok(fs.existsSync(path.join(sending, "ltr_stuck.json")));
  assert.equal(fs.existsSync(path.join(run, "outbox", "ltr_stuck.json")), false);
  assert.ok(fs.existsSync(path.join(run, "outbox", ".mac-msg_mac.json")));
});

test("a box tells its peers its agents as they change, and every ten minutes", async t => {
  fresh({ peersFrom: { [mac.pub]: { at: 1, peers: [mac.peer, second.peer] } } });
  const { target } = await engine(t);
  const sent = [];
  const host = { send: bytes => sent.push(bytes) };
  const readEngine = () => target;
  const now = Date.now();
  await link.announce(host, readEngine, link.readLink(), now);
  const to = bytes => [mac, second].find(each => k(bytes.subarray(1, 17)) === each.address);
  assert.deepEqual(sent.map(bytes => opened(bytes, to(bytes)).address).sort(), [mac.address, second.address].sort());
  assert.deepEqual(opened(sent[0], to(sent[0])).payload.agents.list, []);
  await link.announce(host, readEngine, link.readLink(), now + 60_000);
  assert.equal(sent.length, 2, "the same, within ten minutes: not again");
  await link.announce(host, readEngine, link.readLink(), now + 601_000);
  assert.equal(sent.length, 4);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(run, "agents.json"), "utf8")), { machine: "lokum", agents: [] });

  // A peer that just connected may have missed it (the relay keeps nothing): it asks, and is told
  // again at the next round; this box, just connected itself, tells each and asks them.
  link.peerMail(second.peer, { ask: "agents", at: now });
  await link.announce(host, readEngine, link.readLink(), now + 602_000);
  assert.equal(sent.length, 5);
  assert.equal(to(sent[4]), second);
  assert.equal(opened(sent[4], second).payload.ask, undefined, "an answer doesn't ask back");
  await link.announce(host, readEngine, link.readLink(), now + 603_000, true);
  assert.equal(sent.length, 7);
  assert.equal(opened(sent[6], to(sent[6])).payload.ask, "agents");
});

test("a machine a Mac removed no longer counts that Mac: its peers and lists go, another Mac's stay", () => {
  const other = box("mac");
  fresh({ macs: [mac.pub, other.pub], peersFrom: { [mac.pub]: { at: 1, peers: [mac.peer, second.peer] }, [other.pub]: { at: 1, peers: [other.peer] } },

    phones: [{ key: k(crypto.randomBytes(32)), name: "Phone", added: 1, from: "mac", mac: mac.pub }] });
  fs.writeFileSync(path.join(run, "peer-agents.json"), JSON.stringify({ [second.pub]: { at: 1, list: [] }, [other.pub]: { at: 1, list: [] } }));
  assert.equal(link.leave(stranger.pub), false, "not one of its Macs: nothing changes");
  assert.equal(link.leave(mac.pub), true);
  const after = link.readLink();
  assert.deepEqual(link.macsOf(after), [other.pub]);
  assert.equal(after.mac, other.pub);
  assert.deepEqual(link.peersOf(after).map(peer => peer.name), ["mac"]);
  assert.deepEqual(after.phones, [], "the phones it listed go with it");
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(run, "peer-agents.json"), "utf8"))), [other.pub]);
});

// A Mac that signs its documents, and its seed; a machine's signing key, as the Mac's peers
// document names it.
const signer = () => {
  const seed = link.newSigningSeed();
  const counts = {};
  return { seed, key: link.signingKeyOf(seed), doc: (kind, body) => link.signDoc(seed, kind, (counts[kind] = (counts[kind] ?? 0) + 1), body) };
};

test("your personalities go box to box with no Mac: a peer's view met with this box's, a removal winning, and bots here with one that changed told", async () => {
  const macSigner = signer(), secondSigner = signer();
  const signed = { ...second.peer, sign: secondSigner.key };
  fresh({ sign: link.newSigningSeed(), macSigns: { [mac.pub]: macSigner.key } });
  const library = path.join(home, "bots", "personalities.json");
  fs.rmSync(path.join(home, "bots"), { recursive: true, force: true });
  link.changePersonalities(() => ({ personalities: [{ id: "custom.calm", name: "Calm", description: "Calm and brief.", updated: 10 }], removed: [] }));
  const host = { sent: [], send(bytes) { this.sent.push(bytes); }, keepOnly() {} };
  await link.receiveDocs({ key: mac.pub, sign: macSigner.key }, { give: [macSigner.doc("peers", { boxes: [{ ...mac.peer, sign: macSigner.key }, signed, { ...here.peer, sign: link.ownSign(link.readLink()) }], moved: [], left: [] })] }, host);
  // A bot here with it, and the engine its conversation runs on.
  const folder = path.join(home, "bots", "bot_scout00001");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "bot.json"), JSON.stringify({ kuvo: 1, id: "bot_scout00001", name: "Scout", job: "", look: {}, personality: "custom.calm", created: "2026-10-01T09:00:00Z" }));
  fs.writeFileSync(path.join(folder, "session"), "ses_scout");
  fs.writeFileSync(path.join(home, "bots", "kit.json"), JSON.stringify({ kuvo: 1, templates: [], personalities: [], looks: {}, projects: [], rules: [],
    instructions: "You are ⟦name⟧.\n⟦personality⟧\nMemory: ⟦folder⟧.", jobInstructions: "You are ⟦name⟧: ⟦job⟧.\n⟦personality⟧\n⟦jobDetails⟧\nMemory: ⟦folder⟧.", personalityWords: "Your personality: ⟦name⟧. ⟦description⟧", projectNote: "", identityNote: "", memory: "", greeting: "", timeZone: "UTC" }));
  const told = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", chunk => body += chunk);
    request.on("end", () => {
      if (request.method === "PUT") told.push({ url: request.url, value: JSON.parse(body).value });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  fs.writeFileSync(path.join(home, "run", "engine.json"), JSON.stringify({ port: server.address().port, password: "pw" }));
  try {
    // The other machine changed it later, and made another: its view, taken here, the bot told, and
    // this box's own view, changed, given to the boxes that take it.
    host.sent.length = 0;
    await link.receiveDocs(signed, { give: [link.signDoc(secondSigner.seed, "personalities", 5, { personalities: [
      { id: "custom.calm", name: "Calm", description: "Calm, brief and kind.", symbol: "person.crop.circle", updated: 20 },
      { id: "custom.bold", name: "Bold", description: "Bold.", symbol: "person.crop.circle", updated: 5 },
    ], removed: [] })] }, host);
    assert.deepEqual(link.readPersonalities(library).personalities.map(each => each.description).sort(), ["Bold.", "Calm, brief and kind."]);
    assert.equal(told.length, 1);
    assert.equal(told[0].url, "/api/experimental/session/ses_scout/instructions/entries/kuvo.bot");
    assert.match(told[0].value, /Calm, brief and kind\./);
    const given = host.sent.map(bytes => opened(bytes, [mac, second].find(each => k(bytes.subarray(1, 17)) === each.address)));
    assert.deepEqual(given.map(each => each.address).sort(), [mac.address, second.address].sort());
    assert.ok(given.every(each => each.payload.docs.give.some(envelope => link.readDoc(envelope)?.kind === "personalities")));
    // A stranger's view, or one the Mac didn't sign as the machine's, changes nothing; nor does an
    // older one of the machine's.
    await link.receiveDocs(stranger.peer, { give: [signer().doc("personalities", { personalities: [{ id: "custom.sly", name: "Sly", description: "Sly.", updated: 1 }], removed: [] })] }, host);
    await link.receiveDocs(signed, { give: [link.signDoc(secondSigner.seed, "personalities", 4, { personalities: [{ id: "custom.calm", name: "Calm", description: "Old.", updated: 99 }], removed: [] })] }, host);
    assert.deepEqual(link.readPersonalities(library).personalities.map(each => each.id).sort(), ["custom.bold", "custom.calm"]);
    // A removal wins, and the bot is told it's gone.
    await link.receiveDocs(signed, { give: [link.signDoc(secondSigner.seed, "personalities", 6, { personalities: [], removed: [{ id: "custom.calm", removed: 21 }] })] }, host);
    assert.equal(told.length, 2, JSON.stringify(told.map(each => each.value)));
    assert.doesNotMatch(told[1].value, /Calm/);
  } finally {
    server.closeAllConnections();
    server.close();
    fs.rmSync(path.join(home, "bots"), { recursive: true, force: true });
    fs.rmSync(path.join(home, "run", "engine.json"), { force: true });
  }
});

test("a Mac's peers document by mail, or passed on by a peer, counts once it's that Mac's signature; a list a peer passes on unsigned, never", async () => {
  const third = box("machine", "third"), fourth = box("machine", "fourth");
  const macSigner = signer(), secondSigner = signer(), thirdSigner = signer();
  const named = (each, by) => ({ ...each.peer, sign: by.key });
  fresh({ sign: link.newSigningSeed(), macSigns: { [mac.pub]: macSigner.key } });
  const mine = () => ({ ...here.peer, sign: link.ownSign(link.readLink()) });
  const names = () => link.peersOf(link.readLink()).map(peer => peer.name).sort();
  const host = { send() {}, keepOnly() {} };
  const first = macSigner.doc("peers", { boxes: [named(mac, macSigner), named(second, secondSigner), mine()], moved: [], left: [] });
  link.receiveMail(mailFrom(mac, { docs: { give: [first] }, at: 1 }), host, (sender, payload) => link.peerMail(sender, payload, host));
  for (let i = 0; i < 50 && names().length < 2; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(names(), ["mac", "second"]);
  // The Mac added `third` while this box was away: `second` passes on the Mac's document as the Mac
  // signed it.
  const added = macSigner.doc("peers", { boxes: [named(mac, macSigner), named(second, secondSigner), named(third, thirdSigner), mine()], moved: [], left: [] });
  await link.receiveDocs(named(second, secondSigner), { give: [added] }, host);
  assert.deepEqual(names(), ["mac", "second", "third"]);
  // Lists passed on the way an earlier bridge did, unsigned, change nothing.
  link.receiveMail(mailFrom(second, { vouched: { lists: [{ mac: mac.pub, at: Date.now(), peers: [mac.peer, fourth.peer] }] }, at: 1 }), host, (sender, payload) => link.peerMail(sender, payload, host));
  assert.deepEqual(names(), ["mac", "second", "third"]);
  // So `third` can write here now.
  const heard = [];
  link.receiveMail(mailFrom(third, { agents: { at: 1, list: [] } }), undefined, sender => heard.push(sender.name));
  assert.deepEqual(heard, ["third"]);
  // The Mac removed this machine: its newer document says so, and it no longer counts here.
  await link.receiveDocs(named(second, secondSigner), { give: [macSigner.doc("peers", { boxes: [named(mac, macSigner), named(second, secondSigner)], moved: [], left: [here.pub] })] }, host);
  assert.deepEqual(link.macsOf(link.readLink()), []);
  assert.deepEqual(names(), []);
});

test("a Mac that signs no documents yet: its list is never passed on, and once it signs one, that takes the list's place", async () => {
  const macSigner = signer(), secondSigner = signer();
  fresh({ sign: link.newSigningSeed() });
  link.receiveMail(mailFrom(mac, { at: 10, peers: [mac.peer, second.peer, here.peer] }));
  assert.deepEqual(link.peersOf(link.readLink()).map(peer => peer.name).sort(), ["mac", "second"]);
  // What this box gives others of documents: none of that list (nobody signed it), and no digest
  // of it.
  assert.deepEqual(link.digestOf(link.readLink()).filter(([, kind]) => kind === "peers"), []);
  // Set up again by that Mac, updated: its key, and its document, take the list's place.
  link.updateLink(current => {
    current.macSigns = { [mac.pub]: macSigner.key };
    delete current.legacy[mac.pub];
    return current;
  });
  await link.receiveDocs({ key: mac.pub, sign: macSigner.key }, { give: [macSigner.doc("peers", { boxes: [{ ...mac.peer, sign: macSigner.key }, { ...second.peer, sign: secondSigner.key }], moved: [], left: [] })] }, { send() {}, keepOnly() {} });
  assert.deepEqual(link.peersOf(link.readLink()).map(peer => [peer.name, peer.sign]).sort(), [["mac", macSigner.key], ["second", secondSigner.key]]);
  // Its unsigned list in mail, after, changes nothing.
  link.receiveMail(mailFrom(mac, { at: 20, peers: [mac.peer] }));
  assert.deepEqual(link.peersOf(link.readLink()).map(peer => peer.name).sort(), ["mac", "second"]);
});

// Your other computers (PROTOCOL.md, "Peers"): who they are, their agents, and letters between
// them, by mail through the relay. Run with `node --test Packages/KuvoLink/Tests/Bridge/*.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runningAs } from "./running-as.js";
import { removeAtEnd } from "./at-end.js";

// The bridge keeps its state in KUVO_HOME, so give it a folder of its own before loading it.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-peers-"));
process.env.KUVO_HOME = home;
removeAtEnd(home);
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");

const run = path.join(home, "run");
const k = key => key.toString("base64url");
// A box: its key, and how a Mac lists it.
const box = (kind, id) => {
  const key = link.newKey();
  const address = k(link.addressOf(crypto.randomBytes(32)));
  return { key, pub: k(link.publicOf(key)), address, peer: { key: k(link.publicOf(key)), address, name: id ?? kind, kind, ...(id ? { id } : {}) } };
};
const here = box("machine", "devbox"), mac = box("mac"), second = box("machine", "second"), stranger = box("machine", "stranger");
const fresh = (extra = {}) => {
  fs.rmSync(run, { recursive: true, force: true });
  fs.mkdirSync(run, { recursive: true });
  link.writeLink({ secret: crypto.randomBytes(32).toString("base64url"), key: k(here.key), relay: "wss://relay.test", name: "devbox", id: "devbox", mac: mac.pub, macs: [mac.pub], phones: [], ...extra });
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

test("a machine that was off for weeks keeps both its Macs when one writes first: only time its box ran counts toward a Mac's 30 days", () => {
  const other = box("mac"), phone = { key: k(crypto.randomBytes(32)), name: "Other iPhone", added: 1, from: "mac", mac: other.pub, pairing: "" };
  const day = 24 * 3600 * 1000, now = Date.now(), then = now - 35 * day;
  const macs = () => link.macsOf(link.readLink());
  // Last running five weeks ago, when both Macs had just written; and the same from a box that
  // noted no time running yet (its Macs' last words stand for it).
  for (const noted of [true, false]) {
    fresh({ macs: [mac.pub, other.pub], macSeen: { [mac.pub]: then, [other.pub]: then }, phones: [phone] });
    if (noted) link.noteOnline(then);
    link.receiveMail(mailFrom(mac, { agents: { at: 1, list: [] } }));
    assert.deepEqual(macs(), [mac.pub, other.pub], noted ? "noted" : "not noted");
    assert.deepEqual(link.readLink().phones.map(each => each.name), ["Other iPhone"]);
  }
  // Running all that time, the relay there or not, and not a word from the other Mac: it no longer
  // counts, nor its phones.
  fresh({ macs: [mac.pub, other.pub], macSeen: { [mac.pub]: then, [other.pub]: then }, phones: [phone] });
  for (let at = then; at < now; at += 60_000 * 4) link.noteOnline(at);
  assert.deepEqual(macs(), [mac.pub, other.pub], "only heard from as a Mac writes");
  link.receiveMail(mailFrom(mac, { agents: { at: 1, list: [] } }));
  assert.deepEqual(macs(), [mac.pub]);
  assert.deepEqual(link.readLink().phones, []);
});

test("a machine's clock set wrong and then right (a board without a clock battery) moves no Mac nearer its 30 days, or past them", () => {
  const other = box("mac"), day = 24 * 3600 * 1000, now = Date.now();
  const seen = { [mac.pub]: now - 10 * day, [other.pub]: now - 20 * day };
  for (const wrong of [now - 56 * 365 * day, now + 40 * day]) {
    fresh({ macs: [mac.pub, other.pub], macSeen: { ...seen } });
    link.noteOnline(now);
    const before = link.readLink().macSeen;
    link.noteOnline(wrong);
    link.noteOnline(now + 60_000);
    const after = link.readLink().macSeen;
    for (const key of [mac.pub, other.pub]) assert.ok(Math.abs(after[key] - before[key]) <= 60_000, `moved ${after[key] - before[key]} ms`);
    link.receiveMail(mailFrom(mac, { agents: { at: 1, list: [] } }));
    assert.deepEqual(link.macsOf(link.readLink()), [mac.pub, other.pub]);
  }
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
  const composed = link.composeAgents([agent("ses_h1", "Here")], "devbox", [second.peer, mac.peer], told);
  assert.deepEqual(composed, {
    machine: "devbox",
    agents: [
      { session: "ses_h1", name: "Here", kind: "session", machine: "devbox" },
      { session: "ses_m1", name: "Release", kind: "bot" },
      { session: "ses_o1", name: "Old one", kind: "session", machine: "old" },
      // Listed by the Mac and a machine: the Mac's word.
      { session: "ses_b1", name: "Again", kind: "session" },
    ],
  });
  assert.equal(link.peerOf("ses_o1", [second.peer, mac.peer], told)?.name, "mac", "one a Mac speaks for goes through it");
  assert.equal(link.composeAgents([], "devbox", [second.peer], told).agents.find(each => each.session === "ses_b1")?.machine, "second");
  assert.equal(link.peerOf("ses_nobody", [second.peer, mac.peer], told), null);

  // One machine claiming another's session: neither's, so letters for it go nowhere, and it isn't listed.
  assert.equal(link.takeAgents(stranger.peer, { at: 1, list: [agent("ses_b1", "Not API")] }, file, lock), true);
  const claimed = link.readPeerAgents(file);
  assert.equal(link.peerOf("ses_b1", [second.peer, stranger.peer, mac.peer], claimed)?.name, "mac", "the Mac lists it too: the Mac's word");
  assert.equal(link.takeAgents(stranger.peer, { at: 2, list: [agent("ses_b2", "Claimed")] }, file, lock), true);
  assert.equal(link.takeAgents(second.peer, { at: 6, list: [agent("ses_b2", "Mine")] }, file, lock), true);
  const both = link.readPeerAgents(file);
  assert.equal(link.peerOf("ses_b2", [second.peer, stranger.peer], both), null);
  assert.equal(link.composeAgents([], "devbox", [second.peer, stranger.peer], both).agents.some(each => each.session === "ses_b2"), false);
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
      if (/^\/api\/session\/ses_(target|mine)\/prompt$/.test(request.url) && request.method === "POST") {
        prompts.push({ ...JSON.parse(body), session: request.url.split("/")[3] });
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

test("a letter waiting for the coding agents there stops coming again once they've stayed down a while (stopped for good), and is refused as for no conversation", async t => {
  fresh();
  const { target } = await engine(t);
  const said = [];
  const letter = { id: "ltr_" + crypto.randomBytes(6).toString("hex"), from: "ses_sender", to: "ses_gone", text: "Still there?", at: Date.now() };
  const take = now => link.takeLetter(second.peer, letter,
    { send: (peer, message) => said.push(message.delivered), targets: [target], peers: [second.peer], told: {}, wait: 10, bridge: false, now });

  const first = Date.now();
  await take(first);
  await take(first + 29 * 60_000);
  assert.deepEqual(said.map(answer => answer.retry), [true, true]);
  await take(first + 31 * 60_000);
  assert.deepEqual([said[2].ok, said[2].retry, said[2].why], [false, undefined, "There's no such conversation here, and its coding agents aren't running."]);
});

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
  // The sending box's own word for a conversation that moved here (its sessions' news, say), to one
  // put away here: it comes again, as it would have waited there for the conversation to be brought back.
  said.length = 0;
  await take(second.peer, letter({ to: "ses_archived", from: null, note: { from: "Its sessions", words: "The build passed.", line: "The build passed.", delivery: "queue" } }));
  assert.deepEqual([said[0].delivered.ok, said[0].delivered.retry], [false, true], said[0].delivered.why);
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
  assert.equal(said.filter(each => each.delivered.ok).length, 14, "twenty in ten minutes: the six before counted, delivered or refused, but not the try that failed as the engine restarted");
  assert.equal(said.at(-1).delivered.retry, true);

  // For a conversation moving to or from another computer now, or that lives on another one now:
  // not delivered, to try again, and it reaches it once it's there.
  said.length = 0;
  const prompted = prompts.length;
  const moving = letter();
  await take(stranger.peer, moving, { moving: async session => session === "ses_target" });
  await take(stranger.peer, letter(), { moved: new Map([["ses_target", second.pub]]) });
  assert.deepEqual(said.map(each => [each.delivered.ok, each.delivered.retry]), [[false, true], [false, true]]);
  assert.equal(prompts.length, prompted);
  await take(stranger.peer, moving);
  assert.equal(prompts.length, prompted + 1, "once it's there");
});

test("a letter from a peer for a conversation the user stopped waits there with its queue: delivered, and one waiting for its answer hears it's stopped", async t => {
  fresh();
  const { prompts, target } = await engine(t);
  fs.writeFileSync(path.join(run, "queues.json"), JSON.stringify({ ses_target: { paused: true, held: [] } }));
  const told = { [second.pub]: { at: 1, list: [{ session: "ses_sender", name: "API", kind: "session" }] } };
  const said = [], answers = [];
  const letter = { id: "ltr_" + crypto.randomBytes(6).toString("hex"), from: "ses_sender", to: "ses_target", text: "Can you check the build?", at: Date.now(), wait: true };
  await link.takeLetter(second.peer, letter, { send: (peer, message) => said.push(message), targets: [target], answer: each => answers.push(each), told, peers: [mac.peer, second.peer], wait: 10 });
  assert.deepEqual(prompts, [], "the engine would run everything waiting with it");
  assert.deepEqual(said, [{ delivered: { id: letter.id, ok: true, answer: false, why: "That conversation is stopped: the user paused it. Your message waits there and goes once they resume it; its answer, if it writes one, comes to you as a message." } }]);
  assert.deepEqual(answers, []);
  const [waiting] = link.queueOf("ses_target").waiting;
  assert.deepEqual([waiting.from, waiting.text], ["API", "Can you check the build?"]);
  const kept = JSON.parse(fs.readFileSync(path.join(run, "waiting", `${waiting.id}.json`), "utf8"));
  assert.equal(kept.text, link.composeLetter("API", "ses_sender", "Can you check the build?", false), "no one waits for its answer by then");
});

test("a letter for a coding agent's conversation that comes while their bridge isn't running is kept to try again, and reaches it once it runs; one no one here knows, with the bridge running, is refused", async t => {
  fresh();
  const { target } = await engine(t);
  fs.writeFileSync(path.join(run, "engine.json"), JSON.stringify(target));
  // The coding agents' bridge, with a Claude Code conversation of its own.
  const prompts = [];
  const bridge = http.createServer((request, response) => {
    let body = "";
    request.on("data", chunk => body += chunk);
    request.on("end", () => {
      const json = value => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      if (request.url === "/api/session/ses_claude") return json({ data: { id: "ses_claude" } });
      if (request.url === "/api/session/ses_claude/prompt" && request.method === "POST") {
        prompts.push(JSON.parse(body));
        return json({});
      }
      response.writeHead(404);
      response.end();
    });
  });
  await new Promise(resolve => bridge.listen(0, "127.0.0.1", resolve));
  t.after(() => bridge.close());
  const said = [];
  // As mail from a peer is taken: where this box's conversations run, as its records say now.
  const take = letter => link.takeLetter(second.peer, letter, { send: (peer, message) => said.push(message), ...link.peerPlaces(), peers: [mac.peer, second.peer], told: {}, wait: 10 });
  const letter = extra => ({ id: "ltr_" + crypto.randomBytes(6).toString("hex"), from: "ses_sender", to: "ses_claude", text: "Can you check the build?", at: Date.now(), ...extra });

  // The bridge isn't up (starting, or starting over): the letter, and a read, come again.
  const waiting = letter(), read = letter({ read: {} });
  await take(waiting);
  await take(read);
  assert.deepEqual(said.map(each => [each.delivered.ok, each.delivered.retry]), [[false, true], [false, true]], said.map(each => each.delivered.why).join("; "));
  assert.equal(prompts.length, 0);

  // Up now: the letter tried again reaches its conversation.
  said.length = 0;
  fs.writeFileSync(path.join(run, "bridge.json"), JSON.stringify({ pid: await runningAs("kuvo-agents", t), port: bridge.address().port, password: "pw" }));
  await take(waiting);
  assert.deepEqual(said, [{ delivered: { id: waiting.id, ok: true } }]);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].text, /Can you check the build\?/);

  // With the bridge up, one for a conversation neither knows: refused for good.
  said.length = 0;
  await take(letter({ to: "ses_nowhere" }));
  assert.deepEqual(said.map(each => [each.delivered.ok, each.delivered.retry, each.delivered.why]), [[false, undefined, "There's no such conversation here."]]);
});

test("a letter that can't be delivered yet, tried again and again, leaves its box's twenty in ten minutes for the ones that can", async t => {
  fresh();
  const { prompts, target } = await engine(t);
  const said = [];
  const take = (letter, extra = {}) => link.takeLetter(second.peer, letter, { send: (peer, message) => said.push(message), targets: [target], peers: [mac.peer, second.peer, stranger.peer], told: {}, wait: 10, ...extra });
  const letter = extra => ({ id: "ltr_" + crypto.randomBytes(6).toString("hex"), from: "ses_sender", to: "ses_target", text: "Can you check the build?", at: Date.now(), ...extra });

  // One for a conversation moving to another computer, and one while the engine restarts, each
  // tried a dozen times.
  const moving = letter(), restarting = letter();
  for (let i = 0; i < 12; i++) {
    await take(moving, { moving: async () => true });
    await take(restarting, { targets: [{ port: 9, password: "pw" }] });
  }
  assert.ok(said.every(each => !each.delivered.ok));
  said.length = 0;
  for (let i = 0; i < 20; i++) await take(letter());
  assert.equal(said.filter(each => each.delivered.ok).length, 20, said.map(each => each.delivered.why).filter(Boolean).join("; "));
  assert.equal(prompts.length, 20);
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
  const sent = [];
  const host = { send: bytes => sent.push(bytes) };

  await link.sendOutbox(host, link.readLink(), now);
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
  assert.equal(JSON.parse(fs.readFileSync(path.join(run, "replies", "ltr_waits.json"), "utf8")).text, "Done.");
  assert.equal(fs.existsSync(path.join(run, "replies", "ltr_waits.wait")), false);
  assert.equal(said.at(-1).delivered.ok, true);

  // Its answer, though the word that it was delivered never came (lost as the relay reconnected):
  // to the tool waiting all the same, and not sent again.
  write("ltr_unsaid", { to: "ses_target", text: "Hi", wait: true, sentTo: second.pub });
  fs.writeFileSync(path.join(run, "replies", "ltr_unsaid.alive"), "");
  await answer(second.peer, { answers: "ltr_unsaid", text: "Done too." });
  assert.equal(JSON.parse(fs.readFileSync(path.join(run, "replies", "ltr_unsaid.json"), "utf8")).text, "Done too.");
  assert.equal(said.at(-1).delivered.ok, true);
  assert.equal(fs.existsSync(path.join(sending, "ltr_unsaid.json")), false);
  // From another box than the one it went to: not its answer.
  write("ltr_unsaid2", { to: "ses_target", text: "Hi", wait: true, sentTo: second.pub });
  fs.writeFileSync(path.join(run, "replies", "ltr_unsaid2.alive"), "");
  await answer(stranger.peer, { answers: "ltr_unsaid2" });
  assert.equal(fs.existsSync(path.join(run, "replies", "ltr_unsaid2.json")), false);
  assert.ok(fs.existsSync(path.join(sending, "ltr_unsaid2.json")));
  fs.rmSync(path.join(sending, "ltr_unsaid2.json"));

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
  await link.sendOutbox(host, link.readLink(), now + 300_000);
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

  // No relay for a long while: letters wait for it, never handed to a Mac over SSH, and a tool
  // waiting for one keeps waiting.
  write("ltr_stuck", { to: "ses_target", text: "Hi", wait: true });
  const before = sent.length;
  link.sendOutbox(host, link.readLink(), now + 400_000, 60 * 60_000);
  assert.equal(sent.length, before);
  assert.ok(fs.existsSync(path.join(sending, "ltr_stuck.json")));
  assert.deepEqual(fs.readdirSync(path.join(run, "outbox")).filter(name => name.endsWith(".json")), []);
  assert.equal(fs.existsSync(path.join(run, "replies", "ltr_stuck.json")), false);
  // The relay back: it goes.
  link.sendOutbox(host, link.readLink(), now + 500_000);
  assert.ok(sent.length > before);
});

test("a letter from a conversation made a moment ago goes after the mail telling its box of it, however soon the outbox runs again", async t => {
  fresh({ peersFrom: { [mac.pub]: { at: 1, peers: [mac.peer, second.peer] } } });
  fs.writeFileSync(path.join(run, "peer-agents.json"), JSON.stringify({ [second.pub]: { at: 1, kind: "machine", list: [{ session: "ses_target", name: "API", kind: "session" }] } }));
  // The engine, slow to list this box's conversations.
  let asked, letGo;
  const askedOnce = new Promise(resolve => { asked = resolve; });
  const released = new Promise(resolve => { letGo = resolve; });
  const server = http.createServer(async (request, response) => {
    const json = value => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    if (!request.url.startsWith("/api/session?")) return json({});
    asked();
    await released;
    json({ data: [{ id: "ses_fresh", title: "Fresh", time: { updated: 2 } }] });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); fs.rmSync(path.join(run, "engine.json"), { force: true }); });
  fs.writeFileSync(path.join(run, "engine.json"), JSON.stringify({ port: server.address().port, password: "pw" }));
  const now = Date.now();
  fs.mkdirSync(path.join(run, "outbox", "sending"), { recursive: true });
  fs.writeFileSync(path.join(run, "outbox", "sending", "ltr_fresh.json"), JSON.stringify({ from: "ses_fresh", name: "Fresh", to: "ses_target", text: "Can you check the build?", at: now }));
  const sent = [];
  const host = { send: bytes => sent.push(bytes) };

  const first = link.sendOutbox(host, link.readLink(), now);
  await askedOnce;
  link.sendOutbox(host, link.readLink(), now + 3000);
  link.sendOutbox(host, link.readLink(), now + 6000);
  assert.equal(sent.length, 0, "not while its box is still being told of its sender");
  letGo();
  await first;
  link.sendOutbox(host, link.readLink(), now + 9000);
  const toSecond = sent.filter(bytes => k(bytes.subarray(1, 17)) === second.address).map(bytes => opened(bytes, second).payload);
  assert.deepEqual(toSecond.map(payload => payload.letter ? payload.letter.id : payload.agents.list.map(agent => agent.session)), [["ses_fresh"], "ltr_fresh"]);
});

test("letters an older Kuvo Code left for a Mac to collect over SSH go from the link instead, unless a Mac took one", () => {
  fresh({ peersFrom: { [mac.pub]: { at: 1, peers: [mac.peer, second.peer] } } });
  const outbox = path.join(run, "outbox");
  fs.mkdirSync(outbox, { recursive: true });
  // As an older kuvo-browser.js left one, and as an older link handed one over without the relay.
  fs.writeFileSync(path.join(outbox, "msg_0123456789.json"), JSON.stringify({ from: "ses_here", name: "Here", to: "ses_target", text: "Hi", wait: false, at: Date.now() }));
  fs.writeFileSync(path.join(outbox, "ltr_handed1.json"), JSON.stringify({ from: "ses_here", to: "ses_target", text: "Hello", wait: false, at: Date.now(), handed: Date.now() }));
  fs.writeFileSync(path.join(outbox, ".mac-msg_taken01.json"), JSON.stringify({ from: "ses_here", to: "ses_target", text: "Taken" }));
  link.sendOutbox({ send() {} }, link.readLink(), Date.now(), 60_000);
  assert.deepEqual(fs.readdirSync(path.join(outbox, "sending")).sort(), ["ltr_handed1.json", "msg_0123456789.json"]);
  assert.deepEqual(fs.readdirSync(outbox).filter(name => name.endsWith(".json")), [".mac-msg_taken01.json"]);
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
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(run, "agents.json"), "utf8")), { machine: "devbox", agents: [] });

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

test("this box's agents worked out twice at once: the one begun last is kept, so an agent made meanwhile isn't dropped by the older", async t => {
  fresh();
  let asked = 0, firstAsked, letGo;
  const first = new Promise(resolve => { firstAsked = resolve; });
  const released = new Promise(resolve => { letGo = resolve; });
  const server = http.createServer(async (request, response) => {
    const json = value => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    if (!request.url.startsWith("/api/session?")) return json({});
    // The older working out reads before the session is made, and is answered last.
    if (++asked === 1) {
      firstAsked();
      await released;
      return json({ data: [] });
    }
    return json({ data: [{ id: "ses_new", title: "New idea", time: { updated: 2 } }] });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const readEngine = () => ({ port: server.address().port, password: "secret" });

  const older = link.refreshOwn(readEngine, link.readLink());
  await first;
  await link.refreshOwn(readEngine, link.readLink());
  letGo();
  await older;

  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(run, "agents.json"), "utf8")).agents.map(agent => agent.session), ["ses_new"]);
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

test("a Mac this box can't reach yet (no peers document names where it is) gets no answer, and taking its mail goes on", async () => {
  const macSigner = signer();
  fresh({ sign: link.newSigningSeed(), macSigns: { [mac.pub]: macSigner.key } });
  const host = { sent: [], send(bytes) { this.sent.push(bytes); }, keepOnly() {} };
  // Its digest names a peers document this box hasn't got, which it would ask for; but nothing can
  // go to it, as it comes from no address this box knows.
  await link.receiveDocs({ key: mac.pub, kind: "mac" }, { have: [[macSigner.key, "peers", 1, "h"]] }, host);
  assert.deepEqual(host.sent, []);
});

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
  fs.mkdirSync(path.join(home, "bin"), { recursive: true });
  fs.writeFileSync(path.join(home, "bin", "bot-words.json"), JSON.stringify({ kuvo: 1, templates: [], personalities: [], looks: {}, here: { mac: {}, machine: {} },
    instructions: ["You are ⟦name⟧⟦jobLine⟧.", "⟦personality⟧", "⟦jobPart⟧", "Memory: ⟦folder⟧."], job: { none: "", line: ": ⟦job⟧", details: "⟦jobDetails⟧" },
    personalityWords: "Your personality: ⟦name⟧. ⟦description⟧", projectNote: "", identityNote: "", memory: "", greeting: "" }));
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

test("letters go oldest first; one whose conversation moved goes where it lives now, whichever box it was left for", async () => {
  fresh({ legacy: { [mac.pub]: { at: 1, peers: [mac.peer, second.peer, stranger.peer], moved: [{ session: "ses_moved", key: stranger.pub }] } } });
  fs.writeFileSync(path.join(run, "peer-agents.json"), JSON.stringify({ [second.pub]: { at: 1, kind: "machine", list: [{ session: "ses_target", name: "API", kind: "session" }, { session: "ses_moved", name: "Moved", kind: "session" }] } }));
  const sending = path.join(run, "outbox", "sending");
  fs.mkdirSync(sending, { recursive: true });
  const now = Date.now();
  // Left in this order, with ids that sort the other way.
  const write = (id, letter) => fs.writeFileSync(path.join(sending, `${id}.json`), JSON.stringify({ from: "ses_here", text: "Hi", wait: false, ...letter }));
  write("ltr_c_first", { to: "ses_target", at: now - 3000 });
  write("ltr_b_second", { to: "ses_target", at: now - 2000 });
  write("ltr_a_third", { to: "ses_target", at: now - 1000 });
  // Left for second (as a Mac leaves one, by its key), but it lives on stranger now.
  write("ltr_moved", { to: "ses_moved", peer: second.pub, at: now - 500 });
  const sent = [];
  const host = { send: bytes => sent.push(bytes) };
  await link.sendOutbox(host, link.readLink(), now);
  link.sendOutbox(host, link.readLink(), now + 3000);
  const went = sent.map(bytes => {
    for (const to of [second, stranger]) try { return { to: to.peer.name, id: opened(bytes, to).payload.letter.id }; } catch {}
    return null;
  }).filter(Boolean);
  assert.deepEqual(went.filter(each => each.to === "second").map(each => each.id), ["ltr_c_first", "ltr_b_second", "ltr_a_third"]);
  assert.deepEqual(went.filter(each => each.id === "ltr_moved").map(each => each.to), ["stranger"]);
});

test("the box's own word for a conversation that moved away goes as a note, so the box it's on now delivers it as this one would have; it all fits, cut where a character ends", () => {
  fresh({ peersFrom: { [mac.pub]: { at: 1, peers: [mac.peer, second.peer] } } });
  const sending = path.join(run, "outbox", "sending");
  fs.mkdirSync(sending, { recursive: true });
  const now = Date.now();
  const long = "é".repeat(30_000);
  fs.writeFileSync(path.join(sending, "ltr_note_away.json"), JSON.stringify({ from: null, to: "ses_away", text: `[The user answered] ${long}`, peer: second.pub, wait: false, at: now,
    note: { from: "Your answer", words: long, line: `You answered: ${long}`, delivery: "queue" } }));
  const sent = [];
  link.sendOutbox({ send: bytes => sent.push(bytes) }, link.readLink(), now);
  assert.equal(sent.length, 1, "it fits what the relay takes");
  const { letter } = opened(sent[0], second).payload;
  assert.deepEqual(Object.keys(letter.note).sort(), ["delivery", "from", "line", "words"]);
  assert.equal(letter.note.from, "Your answer");
  assert.equal(letter.note.delivery, "queue");
  assert.ok(letter.note.words.length > 0 && long.startsWith(letter.note.words));
  assert.ok(letter.note.line.startsWith("You answered: é") && `You answered: ${long}`.startsWith(letter.note.line));
});

test("a letter for a conversation that moved to this box since it was left is delivered here, by its sender's name, and its answer comes to the tool waiting; never mailed back to the box it left", async t => {
  // Second says it moved ses_target here; this box doesn't list it yet.
  fresh({ legacy: { [mac.pub]: { at: 1, peers: [mac.peer, second.peer] } } });
  fs.writeFileSync(path.join(run, "peer-agents.json"), JSON.stringify({ [second.pub]: { at: 1, kind: "machine", list: [], moved: [{ session: "ses_target", key: here.pub, at: Date.now() }] } }));
  const { prompts, target } = await engine(t);
  fs.writeFileSync(path.join(run, "engine.json"), JSON.stringify(target));
  t.after(() => fs.rmSync(path.join(run, "engine.json"), { force: true }));
  const sending = path.join(run, "outbox", "sending");
  fs.mkdirSync(sending, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(sending, "ltr_left_before.json"), JSON.stringify({ from: "ses_here", to: "ses_target", text: "Is the build green?", peer: second.pub, wait: false, at: now - 1000 }));
  const sent = [];
  const host = { send: bytes => sent.push(bytes) };
  // While it moves on again (to a third computer), it waits.
  const move = path.join(run, "moves", "mov_on1.json");
  fs.mkdirSync(path.dirname(move), { recursive: true });
  fs.writeFileSync(move, JSON.stringify({ id: "mov_on1", kind: "chat", thing: "ses_target", name: "API", from: here.pub, to: stranger.pub, role: "from", stage: "sending", step: "send", sessions: ["ses_target"], peer: stranger.pub, tries: 0, started: now }));
  await link.sendOutbox(host, link.readLink(), now - 60_000, 0, undefined, 10);
  assert.deepEqual(prompts, []);
  assert.ok(fs.existsSync(path.join(sending, "ltr_left_before.json")));
  fs.rmSync(move);
  await link.sendOutbox(host, link.readLink(), now, 0, undefined, 10);
  assert.equal(sent.length, 0, "nothing mailed to second");
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].text, /Is the build green\?/);
  assert.ok(!fs.existsSync(path.join(sending, "ltr_left_before.json")));
  // Once this box lists it as its own (second no longer says where it went), the same; this one
  // waited for: its answer comes to the tool.
  fs.writeFileSync(path.join(run, "agents.json"), JSON.stringify({ machine: "devbox", agents: [{ session: "ses_here", name: "Docs", kind: "session", machine: "devbox" }, { session: "ses_target", name: "API", kind: "session", machine: "devbox" }] }));
  fs.writeFileSync(path.join(sending, "ltr_waited.json"), JSON.stringify({ from: "ses_here", to: "ses_target", text: "And the tests?", peer: second.pub, wait: true, at: now }));
  // (Its tool, waiting.)
  fs.mkdirSync(path.join(run, "replies"), { recursive: true });
  fs.writeFileSync(path.join(run, "replies", "ltr_waited.alive"), "");
  await link.sendOutbox(host, link.readLink(), now + 3000, 0, undefined, 10);
  assert.equal(sent.length, 0, "nothing mailed to second");
  assert.equal(prompts.length, 2);
  assert.match(prompts[1].text, /Docs/);
  assert.match(prompts[1].text, /And the tests\?/);
  const answer = JSON.parse(fs.readFileSync(path.join(run, "replies", "ltr_waited.json"), "utf8"));
  assert.equal(answer.text, "On it.");
  // One whose tool stopped waiting: its answer comes to the conversation that asked, as a message,
  // as the box's next round delivers the answers left for it.
  fs.writeFileSync(path.join(sending, "ltr_given_up.json"), JSON.stringify({ from: "ses_mine", to: "ses_target", text: "And the docs?", peer: second.pub, wait: true, at: now }));
  await link.sendOutbox(host, link.readLink(), now + 6000, 0, undefined, 10);
  await link.deliverLeftAnswers(now + 9000);
  assert.deepEqual(prompts.map(each => each.session), ["ses_target", "ses_target", "ses_target", "ses_mine"]);
  assert.match(prompts[3].text, /^\[Message from API · ses_target\][^\n]*\n\nOn it\./);
  assert.equal(fs.existsSync(path.join(run, "replies", "ltr_given_up.json")), false);
});

test("a letter's words are cut where a character ends, never in the middle of one", async t => {
  fresh();
  const { prompts, target } = await engine(t);
  const said = [];
  const long = "a".repeat(31_999) + "😀" + "b";
  // (A box of its own: the others sent their twenty in ten minutes already.)
  const fourth = box("machine", "fourth");
  await link.takeLetter(fourth.peer, { id: "ltr_" + crypto.randomBytes(6).toString("hex"), from: "ses_x", to: "ses_target", text: long, at: Date.now() },
    { send: (peer, message) => said.push(message), targets: [target], told: {}, peers: [fourth.peer], wait: 10 });
  const words = prompts.at(-1).text.split("\n\n").slice(1).join("\n\n");
  assert.equal(words, "a".repeat(31_999), "the emoji that didn't fit whole is left out");
});

test("an answer that came just as the tool waiting for it stopped reaches its conversation as a message, once", async t => {
  fresh({ legacy: { [mac.pub]: { at: 1, peers: [mac.peer, second.peer] } } });
  fs.writeFileSync(path.join(run, "peer-agents.json"), JSON.stringify({ [second.pub]: { at: 1, kind: "machine", list: [{ session: "ses_remote", name: "Remote", kind: "session" }] } }));
  const { prompts, target } = await engine(t);
  // This box's conversation asked second's agent, and waits for its answer (it got there).
  const sending = path.join(run, "outbox", "sending");
  const replies = path.join(run, "replies");
  fs.mkdirSync(sending, { recursive: true });
  fs.mkdirSync(replies, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(sending, "ltr_asked1.json"), JSON.stringify({ from: "ses_target", to: "ses_remote", text: "Done?", wait: true, at: now, sentTo: second.pub }));
  link.letterWent(second.peer, { id: "ltr_asked1", ok: true });
  // The tool, still looking.
  fs.writeFileSync(path.join(replies, "ltr_asked1.alive"), "");
  const said = [];
  // (Whatever conversation the answer says it's for: the one here that asked.)
  await link.takeLetter(second.peer, { id: "ltr_answer1", from: "ses_remote", to: "ses_elsewhere", text: "Done, late.", at: now, answers: "ltr_asked1" },
    { send: (peer, message) => said.push(message), targets: [target], told: link.readPeerAgents(), peers: link.peersOf(link.readLink()), now });
  assert.equal(said.at(-1).delivered.ok, true, "it's here");
  // The tool stopped right then, without taking it (its turn was stopped).
  fs.rmSync(path.join(replies, "ltr_asked1.alive"), { force: true });
  fs.writeFileSync(path.join(replies, "ltr_asked1.gaveup"), "");
  await link.deliverLeftAnswers(now + 3000, [target]);
  assert.equal(prompts.at(-1).text, link.composeLetter("Remote", "ses_remote", "Done, late.", false));
  // Once.
  const count = prompts.length;
  await link.deliverLeftAnswers(now + 6000, [target]);
  assert.equal(prompts.length, count);

  // One a subagent asked (it can't take letters): not delivered there.
  fs.writeFileSync(path.join(sending, "ltr_asked2.json"), JSON.stringify({ from: "ses_child", to: "ses_remote", text: "And you?", wait: true, at: now, sentTo: second.pub }));
  link.letterWent(second.peer, { id: "ltr_asked2", ok: true });
  fs.writeFileSync(path.join(replies, "ltr_asked2.alive"), "");
  await link.takeLetter(second.peer, { id: "ltr_answer2", from: "ses_remote", to: "ses_child", text: "Me too.", at: now, answers: "ltr_asked2" },
    { send: (peer, message) => said.push(message), targets: [target], told: link.readPeerAgents(), peers: link.peersOf(link.readLink()), now });
  fs.rmSync(path.join(replies, "ltr_asked2.alive"), { force: true });
  await link.deliverLeftAnswers(now + 20_000, [target]);
  assert.equal(prompts.length, count);
  assert.equal(fs.existsSync(path.join(replies, "ltr_asked2.json")), false, "not kept either");
});

test("an answer left for a conversation the engine doesn't know is kept while the coding agents' bridge isn't running (it may be the bridge's), and dropped once it runs and has none", async t => {
  fresh({ peersFrom: { [mac.pub]: { at: 1, peers: [mac.peer, second.peer] } } });
  const { prompts, target } = await engine(t);
  const replies = path.join(run, "replies");
  fs.mkdirSync(replies, { recursive: true });
  // Its tool stopped waiting as the answer came, for Scout's conversation (a coding agent's).
  fs.writeFileSync(path.join(replies, "ltr_scout1.json"), JSON.stringify({ text: "Done.", to: "ses_scout", from: "ses_remote", name: "Remote" }));
  fs.writeFileSync(path.join(replies, "ltr_scout1.gaveup"), "");
  await link.deliverLeftAnswers(Date.now(), [target], false);
  assert.equal(fs.existsSync(path.join(replies, "ltr_scout1.json")), true, "kept for when the bridge runs");
  await link.deliverLeftAnswers(Date.now(), [target], true);
  assert.equal(fs.existsSync(path.join(replies, "ltr_scout1.json")), false, "the bridge runs and has no such conversation: gone");
  assert.deepEqual(prompts, []);
});

test("a conversation read by mail whose tool stopped waiting as it came is dropped, never delivered as a message", async () => {
  fresh({ peersFrom: { [mac.pub]: { at: 1, peers: [mac.peer, second.peer] } } });
  const replies = path.join(run, "replies");
  fs.mkdirSync(replies, { recursive: true });
  // The letter that asked, as the link keeps it once the other computer has it.
  fs.writeFileSync(path.join(replies, "ltr_read01.wait"), JSON.stringify({ from: "ses_here", to: "ses_target", text: "read", wait: true, sentTo: second.pub, read: {} }));
  fs.writeFileSync(path.join(replies, "ltr_read01.alive"), "");
  assert.equal(link.answered(second.peer, { answers: "ltr_read01", from: "ses_target", text: "# API\n\nEverything it said." }), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(replies, "ltr_read01.json"), "utf8")), { text: "# API\n\nEverything it said.", read: true });
  // Its tool stopped before it read it.
  fs.rmSync(path.join(replies, "ltr_read01.alive"));
  fs.writeFileSync(path.join(replies, "ltr_read01.gaveup"), "");
  // (No engine here: one asked to take it would throw, and the answer would stay to try again.)
  await link.deliverLeftAnswers(Date.now(), []);
  assert.equal(fs.existsSync(path.join(replies, "ltr_read01.json")), false, "gone, not kept to deliver");
  assert.equal(fs.existsSync(path.join(replies, "ltr_read01.gaveup")), false);
});

test("a message sent without waiting that the box it went to refuses: its sender hears why, once, as the box's own word", async t => {
  fresh({ legacy: { [mac.pub]: { at: 1, peers: [mac.peer, second.peer] } } });
  const { target, prompts } = await engine(t);
  fs.writeFileSync(path.join(run, "engine.json"), JSON.stringify(target));
  fs.writeFileSync(path.join(run, "peer-agents.json"), JSON.stringify({ [second.pub]: { at: 1, list: [{ session: "ses_target", name: "API", kind: "session" }] } }));
  const sending = path.join(run, "outbox", "sending");
  fs.mkdirSync(sending, { recursive: true });
  const file = path.join(sending, "ltr_refused.json");
  const now = Date.now();
  fs.writeFileSync(file, JSON.stringify({ from: "ses_mine", to: "ses_target", text: "Hello", wait: false, at: now, sentTo: second.pub }));
  link.letterWent(stranger.peer, { id: "ltr_refused", ok: false, why: "No." }, now);
  assert.ok(fs.existsSync(file), "only the box it went to can refuse it");
  link.letterWent(second.peer, { id: "ltr_refused", ok: false, why: "That conversation doesn't take messages." }, now);
  assert.ok(JSON.parse(fs.readFileSync(file)).note, "its notice takes its place in the outbox");
  assert.equal(fs.readdirSync(sending).length, 1, "the message itself never goes again");
  await link.sendOutbox({ send: () => assert.fail("the notice belongs here") }, link.readLink(), now);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].session, "ses_mine");
  assert.equal(prompts[0].text, "[Not delivered] Your message to API on second wasn't delivered. Second said: That conversation doesn't take messages.");
  assert.equal(prompts[0].delivery, "queue");
  assert.deepEqual(prompts[0].metadata.kuvo.note, { from: "Your other computers", line: "Your message to API on second wasn't delivered" });
  assert.ok(!prompts[0].text.includes("ses_target"));
  assert.equal(fs.readdirSync(sending).length, 0);
});

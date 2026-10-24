// What boxes copy between them as signed documents (PROTOCOL.md, "Documents"): a Mac's peers, the
// phones each box pairs and removes, and your personalities. Several boxes in this process, each
// with its own state, and a relay between them that drops what goes to a box that isn't connected.
// Run with `node --test Packages/KuvoLink/Tests/Bridge/*.test.js`.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-documents-"));
process.env.KUVO_HOME = home;
after(() => fs.rmSync(home, { recursive: true, force: true }));
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");

const k = bytes => bytes.toString("base64url");
const vectors = name => JSON.parse(fs.readFileSync(new URL(`../../Vectors/${name}`, import.meta.url), "utf8"));
const phoneKey = name => crypto.createHash("sha256").update(name).digest("base64url");

// A machine: its keys, how a Mac's peers document names it, and its state, with a library file of
// its own (for the personalities routes, as a phone uses them there).
function machine(name) {
  const key = link.newKey(), sign = link.newSigningSeed();
  const folder = fs.mkdtempSync(path.join(home, `${name}-`));
  return {
    name,
    file: path.join(folder, "personalities.json"),
    lock: path.join(folder, ".lock"),
    entry: { key: k(link.publicOf(key)), sign: link.signingKeyOf(sign), address: k(link.addressOf(crypto.randomBytes(32))), name, kind: "machine", id: `${name}.invalid` },
    state: { link: { key: k(key), sign, secret: k(crypto.randomBytes(32)), relay: "wss://relay.invalid", macs: [], phones: [] }, library: { personalities: [], removed: [] }, parts: new Map() },
    online: true,
  };
}

// A Mac: its keys, and the versions it has signed of each of its documents.
function mac(name = "Mac") {
  const key = link.newKey(), sign = link.newSigningSeed();
  const counts = {};
  return {
    name,
    sign,
    entry: { key: k(link.publicOf(key)), sign: link.signingKeyOf(sign), address: k(link.addressOf(crypto.randomBytes(32))), name, kind: "mac" },
    doc(kind, body) {
      counts[kind] = (counts[kind] ?? 0) + 1;
      return link.signDoc(sign, kind, counts[kind], body);
    },
    peers(boxes, extra = {}) {
      return this.doc("peers", { boxes: [this.entry, ...boxes.map(box => box.entry)], moved: [], left: [], ...extra });
    },
  };
}

// The relay between them: each mail a box sends goes to its box at once if that one is connected,
// and is dropped if it isn't (the relay keeps nothing). `drop` drops the next mails to a box.
function relay(boxes) {
  const byKey = new Map(boxes.map(box => [box.entry.key, box]));
  const dropping = new Map();
  const queue = [];
  const sent = [];
  const pump = () => {
    while (queue.length) {
      const { from, to, payload } = queue.shift();
      const box = byKey.get(to.key);
      sent.push({ from: from.name, to: to.name ?? to.key, payload });
      if (!box || !box.online) continue;
      if ((dropping.get(box) ?? 0) > 0) {
        dropping.set(box, dropping.get(box) - 1);
        continue;
      }
      const work = link.docsWork(box.state, from.entry, payload);
      send(box, work.send);
    }
  };
  const send = (from, sends) => {
    for (const { to, docs } of sends ?? []) for (const payload of link.docMails(docs)) queue.push({ from, to, payload });
    pump();
  };
  return {
    sent,
    send,
    drop: (box, count = 1) => dropping.set(box, count),
    // A Mac (or any box) gives documents to the ones listed.
    give(from, to, envelopes) {
      for (const box of to) for (const payload of link.docMails({ give: envelopes })) queue.push({ from, to: box.entry, payload });
      pump();
    },
    // A box connects to the relay again, and meets the others.
    connect(box) {
      box.online = true;
      send(box, link.greetWork(box.state).send);
    },
    // Something changed on a box (a phone, a personality): what changed goes to the others.
    changed(box) {
      send(box, link.changedWork(box.state).send);
    },
    // A box's agents, every ten minutes, with its digest (`announce`).
    agents(box) {
      const have = link.digestOf(box.state.link);
      send(box, link.peersOf(box.state.link).filter(peer => peer.sign).map(peer => ({ to: peer, docs: { have } })));
    },
  };
}

// A machine set up by a Mac, as setup does it over SSH: the Mac's keys, then its documents.
function setUp(box, by, envelopes) {
  box.state.link.macs = [...new Set([...box.state.link.macs, by.entry.key])];
  box.state.link.mac = by.entry.key;
  box.state.link.macSigns = { ...(box.state.link.macSigns ?? {}), [by.entry.key]: by.entry.sign };
  link.docsWork(box.state, by.entry, { give: envelopes });
}

const names = box => link.peersOf(box.state.link).map(peer => peer.name).sort();
const phones = box => box.state.link.phones.map(phone => phone.key).sort();

// A personality made or changed through a box's routes, as a phone does it there.
function personalities(box, method, id, body) {
  fs.writeFileSync(box.file, JSON.stringify({ kuvo: 1, ...box.state.library }));
  const answer = link.answerPersonalities(method, id, body, box.file, box.lock);
  box.state.library = link.readPersonalities(box.file);
  return answer;
}

test("documents verify as the vectors say, and turn away the ones that don't (Vectors/docs.json)", () => {
  const v = vectors("docs.json");
  for (const each of v.taken) {
    const doc = link.readDoc(each.envelope);
    assert.ok(doc, each.name);
    assert.deepEqual([doc.origin, doc.kind, doc.n, doc.h], [each.origin, each.kind, each.n, each.h], each.name);
  }
  for (const each of v.refused) assert.equal(link.readDoc(each.envelope), null, each.name);
  // Too big for one mail: in parts, which put together verify.
  const signed = { d: v.parts.parts.map(part => part.d).join(""), s: v.parts.parts[0].s };
  const doc = link.readDoc(signed);
  assert.deepEqual([doc.origin, doc.kind, doc.n], [v.parts.origin, v.parts.kind, v.parts.n]);
  assert.deepEqual(link.docMails({ give: [signed] }).map(mail => mail.part), v.parts.parts);
});

test("a Mac's newer peers document reaches a box through another while the Mac is away", () => {
  const m = mac(), b = machine("b"), c = machine("c"), d = machine("d");
  const net = relay([b, c, d]);
  const first = m.peers([b, c]);
  setUp(b, m, [first]);
  setUp(c, m, [first]);
  assert.deepEqual(names(c), ["Mac", "b"]);
  // C goes away; the Mac adds D, and tells the boxes it reaches; then the Mac goes away too.
  c.online = false;
  d.online = false;
  const second = m.peers([b, c, d]);
  net.give(m, [b, c], [second]);
  assert.deepEqual(names(b), ["Mac", "c", "d"]);
  assert.deepEqual(names(c), ["Mac", "b"], "C was away");
  // C is back, with the Mac closed: B gives it the Mac's newer word.
  net.connect(c);
  assert.deepEqual(names(c), ["Mac", "b", "d"]);
  // Each box gave it on to the boxes that might lack it, never back to the one it came from, nor to
  // the Mac that signed it.
  const peersGiven = net.sent.filter(each => each.payload.give?.some(envelope => link.readDoc(envelope)?.kind === "peers"));
  assert.deepEqual(peersGiven.map(each => `${each.from}>${each.to}`), ["Mac>b", "Mac>c", "b>c", "b>d", "b>c", "c>d"]);
});

test("a peers document a box forges, alters or replays is turned away; only its Macs say who its boxes are", () => {
  const m = mac(), other = mac("Other"), b = machine("b"), c = machine("c"), x = machine("x");
  const net = relay([b, c]);
  const first = m.peers([b, c]);
  setUp(b, m, [first]);
  setUp(c, m, [first]);
  const second = m.peers([b, c], { moved: [] });
  net.give(m, [c], [second]);
  const before = names(c);
  // B alters the Mac's document to bring X in, keeping the Mac's signature.
  const altered = JSON.parse(Buffer.from(second.d, "base64url").toString());
  altered.n = 9;
  altered.body.boxes.push(x.entry);
  net.give(b, [c], [{ d: k(Buffer.from(JSON.stringify(altered))), s: second.s }]);
  // B signs one naming the Mac as its origin, and one of its own.
  net.give(b, [c], [{ d: k(link.docBytes(m.entry.sign, "peers", 10, altered.body)), s: link.signDoc(b.state.link.sign, "peers", 10, altered.body).s }]);
  net.give(b, [c], [link.signDoc(b.state.link.sign, "peers", 1, { boxes: [x.entry], moved: [], left: [] })]);
  // Another Mac, not C's, signs one.
  net.give(b, [c], [other.peers([c, x])]);
  // B replays the Mac's older one.
  net.give(b, [c], [first]);
  assert.deepEqual(names(c), before);
  assert.equal(c.state.link.docs[`${m.entry.sign} peers`].d, second.d);
});

test("no clock decides anything: the same exchanges come out the same whatever each box's clock says", () => {
  const run = offset => {
    const real = Date.now;
    Date.now = () => real() + offset;
    try {
      const m = mac(), b = machine("b"), c = machine("c");
      const net = relay([b, c]);
      const doc = m.peers([b, c]);
      setUp(b, m, [doc]);
      setUp(c, m, [doc]);
      // A personality made on B, changed on C, met everywhere.
      const [, made] = personalities(b, "POST", undefined, { name: "Calm", description: "Calm." });
      net.changed(b);
      personalities(c, "PATCH", made.id, { description: "Calm and brief." });
      net.changed(c);
      return [names(b), names(c), b.state.library.personalities.map(each => each.description), c.state.library.personalities.map(each => each.description)];
    } finally {
      Date.now = real;
    }
  };
  const year = 365 * 86_400_000;
  const now = run(0);
  assert.deepEqual(now[2], ["Calm and brief."]);
  assert.deepEqual(run(10 * year), now);
  assert.deepEqual(run(-10 * year), now);

  // A box whose clock is years ahead makes one; one with the right time changes it after: its change
  // wins, though its clock is years behind the first's.
  const m = mac(), b = machine("b"), c = machine("c");
  const net = relay([b, c]);
  const doc = m.peers([b, c]);
  setUp(b, m, [doc]);
  setUp(c, m, [doc]);
  const real = Date.now;
  Date.now = () => real() + 10 * year;
  let made;
  try {
    [, made] = personalities(b, "POST", undefined, { name: "Calm", description: "From the future." });
    net.changed(b);
  } finally {
    Date.now = real;
  }
  personalities(c, "PATCH", made.id, { description: "From now." });
  net.changed(c);
  assert.deepEqual(b.state.library.personalities.map(each => each.description), ["From now."]);
});

test("a removal wins over an add that comes after it: a phone, and a personality", () => {
  const m = mac(), a = machine("a"), b = machine("b"), c = machine("c");
  const net = relay([a, b, c]);
  const doc = m.peers([a, b, c]);
  for (const box of [a, b, c]) setUp(box, m, [doc]);
  const lost = phoneKey("lost"), kept = phoneKey("kept");
  const listing = m.doc("phones", { phones: [{ key: lost, name: "Lost", pairing: "p1" }, { key: kept, name: "Kept", pairing: "p2" }], removed: [] });
  net.give(m, [a], [listing]);
  assert.deepEqual(phones(c), [kept, lost].sort(), "A passed it on");
  // You remove the lost phone on the Mac; C hears it, and then B's copy of the older list, late.
  const removal = m.doc("phones", { phones: [{ key: kept, name: "Kept", pairing: "p2" }], removed: [{ key: lost, pairing: "p1" }] });
  net.give(m, [c], [removal]);
  net.give(b, [c], [listing]);
  assert.deepEqual(phones(c), [kept]);
  // A phone paired with the Mac removes itself on B, while the Mac knows nothing of it: the Mac's
  // document still lists it, and B's removal wins on every box.
  assert.equal(link.removePhones(b.state.link, kept, [{ key: kept, pairing: "p2" }]), true);
  net.changed(b);
  assert.deepEqual(phones(c), []);
  assert.deepEqual(phones(a), []);
  // A new pairing on the Mac lets it in again.
  net.give(m, [a], [m.doc("phones", { phones: [{ key: kept, name: "Kept", pairing: "p3" }], removed: [{ key: lost, pairing: "p1" }] })]);
  assert.deepEqual(phones(c), [kept]);

  // A personality removed on A while B changed it (counted higher, too), B's change coming after.
  const [, made] = personalities(a, "POST", undefined, { name: "Calm", description: "Calm." });
  net.changed(a);
  b.online = false;
  personalities(b, "PATCH", made.id, { description: "Changed." });
  personalities(b, "PATCH", made.id, { description: "Changed again." });
  personalities(a, "DELETE", made.id);
  net.changed(a);
  net.connect(b);
  net.changed(b);
  for (const box of [a, b, c]) {
    assert.deepEqual(box.state.library.personalities, [], box.name);
    assert.deepEqual(box.state.library.removed.map(each => each.id), [made.id], box.name);
  }
});

test("a box that lost count of its documents moves past the versions the others have", () => {
  const m = mac(), b = machine("b"), c = machine("c");
  const net = relay([b, c]);
  const doc = m.peers([b, c]);
  setUp(b, m, [doc]);
  setUp(c, m, [doc]);
  for (const name of ["one", "two", "three"]) {
    b.state.link.phones.push({ key: phoneKey(name), name, added: 1, from: "pair", pairing: name });
    net.changed(b);
  }
  const held = () => link.readDoc(c.state.link.docs[`${b.entry.sign} phones`]);
  const had = held().n;
  assert.equal(held().body.phones.length, 3);
  // Its count gone (its folder restored from before, say): what it signs now starts again at 1,
  // which nobody takes, until it meets the others and hears how far it had come.
  delete b.state.link.own;
  b.state.link.phones.push({ key: phoneKey("four"), name: "four", added: 1, from: "pair", pairing: "four" });
  net.changed(b);
  assert.equal(held().n, had);
  assert.equal(held().body.phones.length, 3);
  net.connect(b);
  assert.equal(held().n, had + 1);
  assert.equal(held().body.phones.length, 4);
});

test("what a box gave and didn't arrive comes with its agents: one mail lost while both stay connected", () => {
  const m = mac(), b = machine("b"), c = machine("c");
  const net = relay([b, c]);
  const doc = m.peers([b, c]);
  setUp(b, m, [doc]);
  setUp(c, m, [doc]);
  net.drop(c);
  const [, made] = personalities(b, "POST", undefined, { name: "Calm", description: "Calm." });
  net.changed(b);
  assert.deepEqual(c.state.library.personalities, []);
  net.agents(b);
  assert.deepEqual(c.state.library.personalities.map(each => each.id), [made.id]);
  // Once both have the same, a digest is answered by nothing (each goes to the other and the Mac).
  const before = net.sent.length;
  net.agents(b);
  net.agents(c);
  assert.equal(net.sent.length, before + 4);
});

test("a big library goes in parts; one part changed, and nothing is taken", () => {
  const m = mac(), b = machine("b"), c = machine("c");
  const net = relay([b, c]);
  const doc = m.peers([b, c]);
  setUp(b, m, [doc]);
  setUp(c, m, [doc]);
  for (let i = 0; i < 30; i++) personalities(b, "POST", undefined, { name: `P${i}`, description: "Words and more words. ".repeat(80) });
  const work = link.changedWork(b.state);
  const mails = work.send.filter(({ to }) => to.key === c.entry.key).flatMap(({ docs }) => link.docMails(docs));
  assert.ok(mails.filter(mail => mail.part).length >= 2);
  // One part changed on the way: nothing comes of it.
  const parts = mails.filter(mail => mail.part).map(mail => structuredClone(mail));
  parts[0].part.d = (parts[0].part.d[0] === "A" ? "B" : "A") + parts[0].part.d.slice(1);
  for (const payload of parts) link.docsWork(c.state, b.entry, payload);
  assert.deepEqual(c.state.library.personalities, []);
  // As they were: the library, whole.
  for (const payload of mails) link.docsWork(c.state, b.entry, payload);
  assert.equal(c.state.library.personalities.length, 30);
  // A change past what a document can hold is refused, with why.
  const [status, answer] = personalities(b, "POST", undefined, { name: "One more", description: "Words. ".repeat(285) });
  assert.equal(status, 200, "still room");
  let refused = null;
  for (let i = 0; i < 400 && !refused; i++) {
    const [code, said] = personalities(b, "POST", undefined, { name: `More ${i}`, description: "Words. ".repeat(285) });
    if (code !== 200) refused = [code, said];
  }
  assert.equal(refused?.[0], 400);
  assert.match(refused[1].message, /no room/);
  assert.ok(Buffer.byteLength(JSON.stringify(b.state.library)) <= link.MOST_DOC);
  assert.ok(answer.id);
});

test("boxes that each changed things while apart end up the same, whatever order they meet in", () => {
  const m = mac(), boxes = ["a", "b", "c", "d"].map(machine);
  const net = relay(boxes);
  const doc = m.peers(boxes);
  for (const box of boxes) setUp(box, m, [doc]);
  for (const box of boxes) box.online = false;
  const ids = boxes.map(box => personalities(box, "POST", undefined, { name: `From ${box.name}`, description: "Words." })[1].id);
  personalities(boxes[1], "PATCH", ids[0], { description: "B changed A's." });
  boxes[2].state.library = link.mergePersonalities(boxes[2].state.library, boxes[0].state.library);
  personalities(boxes[2], "DELETE", ids[0]);
  boxes[3].state.link.phones.push({ key: phoneKey("d"), name: "D's", added: 1, from: "pair", pairing: "d1" });
  for (const box of [boxes[3], boxes[1], boxes[0], boxes[2]]) {
    net.connect(box);
    net.changed(box);
  }
  // The same personalities and removals on each (each keeps them in the order it first saw them).
  const same = library => JSON.stringify({ personalities: [...library.personalities].sort((x, y) => x.id.localeCompare(y.id)), removed: library.removed });
  for (const box of boxes) assert.equal(same(box.state.library), same(boxes[0].state.library), box.name);
  assert.deepEqual(boxes[0].state.library.personalities.map(each => each.name).sort(), ["From b", "From c", "From d"]);
  for (const box of boxes.slice(0, 3)) assert.deepEqual(link.readDoc(box.state.link.docs[`${boxes[3].entry.sign} phones`])?.body.phones.map(phone => phone.key), [phoneKey("d")], box.name);
});

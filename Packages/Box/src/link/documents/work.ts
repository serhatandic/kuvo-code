// @ts-nocheck
// Documents (PROTOCOL.md, "Documents")
// What boxes copy between them: who a Mac's boxes are (its peers document), the phones each box
// pairs and removes (its phones document), and your personalities (each box's view of the
// library). Each origin signs its own with a key of its own (Ed25519: `sign` in link.json, made
// with this box's other keys; a Mac's comes in setup, over SSH), and numbers each version; any box
// passes a copy on, and a box keeps the newest one it can verify from each origin it takes that
// kind from. No clock decides anything: boxes tell each other what they have as they meet
// (`have`), what changed as it changes (`give`), and what they have again with their agents.
// Here, what taking and giving them does to link.json; documents/exchange sends it.

import crypto from "node:crypto";
import { DOC_KINDS } from "../../shared/documents";
import { isObject } from "../../shared/json";
import { addressOf } from "../crypto/keys";
import { IS_MAC } from "../home";
import { cleanMoved, leaveMac, macDoc, macsOf, ownKey, peersOf } from "../peers/known";
import { mergePersonalities, MOST_COUNT, readPersonalities } from "../personalities/library";
import { foldPhones, ownPhones } from "../phones";
import { macLink, macSign, updateLink } from "../state";
import { bodyHash, DOC_PART, docKey, held, MOST_DOC, MOST_PARTS, ownSign, readDoc, shortHash, signDoc } from "./format";

// Whether this box takes `kind` from `origin`: who its boxes are, only from its own Macs; phones and
// personalities from those Macs, its peers, and itself (a copy of its own it lost count of).
function takesFrom(link, origin, kind) {
  const macs = macsOf(link).map(mac => macSign(link, mac)).filter(Boolean);
  // (This Mac takes a copy of its own, one it lost count of.)
  if (kind === "peers") return macs.includes(origin) || (IS_MAC && origin === ownSign(link));
  return macs.includes(origin) || origin === ownSign(link) || peersOf(link).some(peer => peer.sign === origin);
}

// Whether the box with the key `to` takes `kind` from `origin`, as far as this box knows: one of
// this box's Macs lists them both (or is `origin`; who a Mac's boxes are, only from that Mac).
function takenBy(link, to, origin, kind) {
  // This Mac's: each of its machines takes all of this Mac's, and the phones and personalities of
  // the others it names (who its boxes are, only from this Mac).
  if (IS_MAC) {
    const peers = peersOf(link);
    return peers.some(peer => peer.key === to) && (origin === ownSign(link) || (kind !== "peers" && peers.some(peer => peer.sign === origin)));
  }
  for (const mac of macsOf(link)) {
    const doc = macDoc(link, mac, "peers");
    const boxes = Array.isArray(doc?.body.boxes) ? doc.body.boxes : [];
    if (!boxes.some(box => box?.key === to)) continue;
    if (origin === doc.origin || (kind !== "peers" && boxes.some(box => box?.sign === origin))) return true;
  }
  return false;
}

// Who this box gives documents to: its peers that sign their own (a Mac that gave no signing key
// yet takes none).
const docPeers = link => peersOf(link).filter(peer => typeof peer.sign === "string");

// A document given (`{d, s}`), taken when it verifies, comes from an origin this box takes that kind
// from, and is newer than the one it has (at the same version, the one whose hash sorts first, so
// every box keeps the same one). Another's personalities aren't kept, only met with this box's own
// (`link.views` notes how far each has come); one of this box's own, newer than it knew of (it lost
// count), moves its count on. The document (`mine` for one of its own), or null.
export function takeDoc(link, envelope) {
  const doc = readDoc(envelope);
  if (!doc || !takesFrom(link, doc.origin, doc.kind)) return null;
  if (doc.origin === ownSign(link)) {
    if ((doc.kind === "peers" && !IS_MAC) || doc.n > MOST_COUNT) return null;
    const had = link.own?.[doc.kind];
    if (had && (doc.n < had.n || (doc.n === had.n && doc.h === had.h))) return null;
    link.own = { ...(link.own ?? {}), [doc.kind]: { n: Math.max(doc.n, had?.n ?? 0), h: doc.h, b: bodyHash(doc.body) } };
    return { ...doc, mine: true };
  }
  const newer = had => !had || doc.n > had.n || (doc.n === had.n && doc.h < had.h);
  if (doc.kind === "personalities") {
    if (!newer(link.views?.[doc.origin])) return null;
    link.views = { ...(link.views ?? {}), [doc.origin]: { n: doc.n, h: doc.h } };
    return doc;
  }
  const key = docKey(doc.origin, doc.kind);
  if (!newer(held(link.docs?.[key]))) return null;
  link.docs = { ...(link.docs ?? {}), [key]: doc.envelope };
  return doc;
}

// Documents from origins this box no longer takes them from (a Mac gone, a box it no longer lists):
// let go. Who its boxes are first, as the rest follows from it.
export function pruneDocs(link) {
  for (const kind of DOC_KINDS) {
    for (const [key, envelope] of Object.entries(link.docs ?? {})) {
      const doc = held(envelope);
      if (!doc) delete link.docs[key];
      else if (doc.kind === kind && !takesFrom(link, doc.origin, doc.kind)) delete link.docs[key];
    }
  }
  for (const origin of Object.keys(link.views ?? {})) if (!takesFrom(link, origin, "personalities")) delete link.views[origin];
}

// This box's own document of `kind` with `body`: the version it has, or the next one when `body`
// changed. `{envelope, changed}`, or null without a signing key.
export function ownDoc(link, kind, body) {
  if (!ownSign(link)) return null;
  const b = bodyHash(body);
  const had = link.own?.[kind];
  const changed = !had || had.b !== b;
  const n = changed ? (had?.n ?? 0) + 1 : had.n;
  const envelope = signDoc(link.sign, kind, n, body);
  if (changed) link.own = { ...(link.own ?? {}), [kind]: { n, h: shortHash(Buffer.from(envelope.d, "base64url")), b } };
  return { envelope, changed };
}

// This box's own documents as they are now (its phones, its view of your personalities), each with
// its next version where it changed: `{phones, personalities}`, each `{envelope, changed}`.
export function ownDocs(state) {
  const docs = {};
  // This Mac's: who its computers are too; its phones only while the phone link's on (its machines
  // keep what they have meanwhile).
  if (IS_MAC) {
    const peers = ownDoc(state.link, "peers", macPeersBody(state.link));
    if (peers) docs.peers = peers;
  }
  const phones = IS_MAC && !macLink.config?.phones ? null : ownDoc(state.link, "phones", ownPhones(state.link));
  if (phones) docs.phones = phones;
  const library = mergePersonalities(state.library);
  if (Buffer.byteLength(JSON.stringify(library)) <= MOST_DOC - 4096) {
    const personalities = ownDoc(state.link, "personalities", library);
    if (personalities) docs.personalities = personalities;
  }
  return docs;
}

// The kinds a box signs itself: who its boxes are, only a Mac.
const ownKinds = () => (IS_MAC ? DOC_KINDS : ["phones", "personalities"]);

// Who this Mac's computers are, as its peers document says: itself and its machines, each with
// the key it signs with; the conversations being moved; and the machines it removed, so they let
// it go (never one that's still one of its machines).
export function macPeersBody(link) {
  const peers = peersOf(link).filter(peer => typeof peer.sign === "string");
  let address = null;
  try { address = addressOf(Buffer.from(link.secret, "base64url")).toString("base64url"); } catch {}
  const me = { key: ownKey(link), sign: ownSign(link), address, name: String(link.name ?? "Mac").slice(0, 100), kind: "mac" };
  const current = new Set(peers.map(peer => peer.key));
  return { boxes: [me, ...peers.map(peer => ({ ...peer, kind: "machine" }))], moved: cleanMoved(link.macMoved), left: (Array.isArray(link.left) ? link.left : []).filter(key => !current.has(key)) };
}

// What this box has, as it tells other boxes: each document's origin, kind, version and hash.
export function digestOf(link) {
  const have = [];
  for (const envelope of Object.values(link?.docs ?? {})) {
    const doc = held(envelope);
    if (doc) have.push([doc.origin, doc.kind, doc.n, doc.h]);
  }
  for (const [origin, seen] of Object.entries(link?.views ?? {})) have.push([origin, "personalities", seen.n, seen.h]);
  const own = ownSign(link);
  if (own) for (const kind of ownKinds()) if (link.own?.[kind]) have.push([own, kind, link.own[kind].n, link.own[kind].h]);
  return have;
}

// A document too big for one mail comes in parts (`{whole, i, of, d, s}`: `whole`, its `d`'s hash),
// put together here, at most four on their way from one box at a time. The document once all are
// here, or null.
export function assemble(parts, from, part) {
  if (!isObject(part) || typeof part.whole !== "string" || !Number.isInteger(part.i) || !Number.isInteger(part.of) || part.of < 2 || part.of > MOST_PARTS
    || part.i < 0 || part.i >= part.of || typeof part.d !== "string" || part.d.length > DOC_PART || typeof part.s !== "string") return null;
  const key = `${from} ${part.whole}`;
  let pending = parts.get(key);
  if (!pending || pending.of !== part.of) {
    const theirs = [...parts.keys()].filter(each => each.startsWith(`${from} `));
    if (theirs.length >= 4) parts.delete(theirs[0]);
    pending = { of: part.of, s: part.s, pieces: new Map() };
    parts.set(key, pending);
  }
  pending.pieces.set(part.i, part.d);
  if (pending.pieces.size < part.of) return null;
  parts.delete(key);
  const d = Array.from({ length: part.of }, (_, i) => pending.pieces.get(i)).join("");
  if (crypto.createHash("sha256").update(d).digest("base64url") !== part.whole) return null;
  return { d, s: pending.s };
}

// What goes to one box (`{give, have, reply}`), as the mails it takes: documents together while
// they fit, a bigger one in parts, the digest last.
export function docMails(docs) {
  const mails = [];
  let give = [], size = 0;
  for (const envelope of docs.give ?? []) {
    const length = envelope.d.length + envelope.s.length + 16;
    if (length > 48_000) {
      const whole = crypto.createHash("sha256").update(envelope.d).digest("base64url");
      const of = Math.ceil(envelope.d.length / DOC_PART);
      for (let i = 0; i < of; i++) mails.push({ part: { whole, i, of, d: envelope.d.slice(i * DOC_PART, (i + 1) * DOC_PART), s: envelope.s } });
      continue;
    }
    if (size + length > 48_000 && give.length) {
      mails.push({ give });
      give = [];
      size = 0;
    }
    give.push(envelope);
    size += length;
  }
  if (give.length) mails.push({ give });
  if (docs.have) mails.push({ have: docs.have, ...(docs.reply ? { reply: true } : {}) });
  return mails;
}

// What this box does with documents another box or Mac sent it (`sender`, `{key, sign?}`; `docs`,
// `{give?, part?, have?, reply?}`), as work on `state` (`{link, library, parts}`, changed in place):
// what it takes, the Macs that said this box is no longer theirs, and what goes to whom now
// (`send`, `[{to, docs}]`). Each document it took goes on to the boxes that take it, but back to the
// one it came from; its own that changed, to all of them; and for a digest, what the sender lacks,
// and, unless it's an answer, this box's own digest when the sender has something newer.
// `stay`: a Mac whose removal of this box it doesn't take (the Mac setting it up over SSH now).
export function docsWork(state, sender, docs, { stay = null } = {}) {
  const { link } = state;
  const sends = new Map();
  const to = (peer, change) => {
    const docs = sends.get(peer.key) ?? { peer, give: [] };
    change(docs);
    sends.set(peer.key, docs);
  };
  const given = Array.isArray(docs?.give) ? docs.give.slice(0, 64) : [];
  if (isObject(docs?.part)) {
    state.parts ??= new Map();
    const whole = assemble(state.parts, sender.key, docs.part);
    if (whole) given.push(whole);
  }
  // Who its boxes are first: the rest is taken from the boxes they name.
  const took = [];
  for (const kind of DOC_KINDS) {
    for (const envelope of given) {
      const peeked = held(envelope);
      if (peeked?.kind !== kind) continue;
      const doc = takeDoc(link, envelope);
      if (doc) took.push(doc);
    }
  }
  const left = [];
  const own = ownKey(link);
  for (const doc of took) {
    if (doc.kind !== "peers") continue;
    const mac = macsOf(link).find(each => macSign(link, each) === doc.origin);
    const named = Array.isArray(doc.body.boxes) && doc.body.boxes.some(box => box?.key === own);
    if (mac && !named && Array.isArray(doc.body.left) && doc.body.left.includes(own)) left.push(mac);
  }
  for (const mac of left.filter(each => each !== stay)) leaveMac(link, mac);
  pruneDocs(link);
  foldPhones(link);
  const personalities = took.filter(doc => doc.kind === "personalities").map(doc => doc.body);
  if (personalities.length) state.library = mergePersonalities(state.library, ...personalities);
  // A digest: what the sender lacks, and whether it has something this box lacks.
  let ask = false;
  if (Array.isArray(docs?.have)) {
    const theirs = new Map();
    for (const entry of docs.have.slice(0, 512)) {
      if (Array.isArray(entry) && typeof entry[0] === "string" && DOC_KINDS.includes(entry[1]) && Number.isSafeInteger(entry[2])) theirs.set(docKey(entry[0], entry[1]), { n: entry[2], h: String(entry[3] ?? "") });
    }
    const self = ownSign(link);
    // One of this box's own further on than it knew (it lost count): its next one goes past it.
    for (const kind of ownKinds()) {
      const there = self && theirs.get(docKey(self, kind));
      if (there && there.n <= MOST_COUNT && there.n > (link.own?.[kind]?.n ?? 0)) link.own = { ...(link.own ?? {}), [kind]: { n: there.n, h: there.h, b: "" } };
    }
    const senderSign = sender.sign ?? macSign(link, sender.key);
    const behind = (key, n, h) => {
      const there = theirs.get(key);
      return !there || there.n < n || (there.n === n && there.h > h);
    };
    for (const envelope of Object.values(link.docs ?? {})) {
      const doc = held(envelope);
      if (doc && behind(docKey(doc.origin, doc.kind), doc.n, doc.h) && takenBy(link, sender.key, doc.origin, doc.kind)) to(sender, docs => docs.give.push(envelope));
    }
    if (!docs.reply) {
      for (const [key, there] of theirs) {
        const [origin, kind] = key.split(" ");
        if (origin === self || (kind === "personalities" && origin !== senderSign) || !takesFrom(link, origin, kind)) continue;
        const have = kind === "personalities" ? link.views?.[origin] : held(link.docs?.[key]);
        if (!have || have.n < there.n || (have.n === there.n && have.h > there.h)) ask = true;
      }
    }
    state.theirs = theirs;
  }
  const ownNow = ownDocs(state);
  const peers = docPeers(link);
  const mine = ownSign(link);
  for (const doc of took.filter(doc => doc.kind !== "personalities" && !doc.mine)) {
    for (const peer of peers) {
      if (peer.key !== sender.key && peer.sign !== doc.origin && takenBy(link, peer.key, doc.origin, doc.kind)) to(peer, docs => docs.give.push(doc.envelope));
    }
  }
  for (const made of Object.values(ownNow)) {
    if (made.changed) for (const peer of peers) if (takenBy(link, peer.key, mine, "phones")) to(peer, docs => docs.give.push(made.envelope));
  }
  // What the sender's digest lacks of this box's own (those that changed went already).
  if (state.theirs) {
    const senderPeer = peers.find(peer => peer.key === sender.key);
    for (const [kind, made] of Object.entries(ownNow)) {
      const record = link.own[kind];
      const there = state.theirs.get(docKey(mine, kind));
      if (senderPeer && !made.changed && (!there || there.n < record.n || (there.n === record.n && there.h > record.h))) to(senderPeer, docs => docs.give.push(made.envelope));
    }
    delete state.theirs;
  }
  if (ask) {
    const senderPeer = peers.find(peer => peer.key === sender.key) ?? sender;
    to(senderPeer, docs => {
      docs.have = digestOf(link);
      docs.reply = true;
    });
  }
  return {
    took,
    left: left.filter(each => each !== stay),
    send: [...sends.values()].filter(docs => docs.give.length || docs.have).map(({ peer, ...docs }) => ({ to: peer, docs: { ...docs, give: dedupe(docs.give) } })),
  };
}
const dedupe = envelopes => [...new Map(envelopes.map(envelope => [envelope.d, envelope])).values()];

// Meeting the others (just connected): this box's own documents as they are now, and its digest to
// each, so each gives what this one lacks, and asks for what it has.
export function greetWork(state) {
  ownDocs(state);
  const have = digestOf(state.link);
  return { send: docPeers(state.link).map(peer => ({ to: peer, docs: { have } })) };
}

// Something changed here (a phone paired or removed, a personality, a Mac's documents that came by
// SSH): this box's own documents that changed go to every box that takes them, and with `tell`,
// its digest too, so each gives what this one lacks and asks for what it has.
export function changedWork(state, tell = false) {
  const made = Object.values(ownDocs(state)).filter(each => each.changed).map(each => each.envelope);
  const mine = ownSign(state.link);
  const have = tell ? digestOf(state.link) : null;
  return {
    send: docPeers(state.link).filter(peer => takenBy(state.link, peer.key, mine, "phones"))
      .map(peer => ({ to: peer, docs: { give: made, ...(have ? { have } : {}) } }))
      .filter(each => each.docs.give.length || each.docs.have),
  };
}

// This box's digest, its own documents brought up to date first.
export function currentDigest() {
  const library = readPersonalities();
  let have = null;
  updateLink(link => {
    if (!link?.sign) return null;
    const before = JSON.stringify(link.own ?? {});
    greetWork({ link, library });
    have = digestOf(link);
    return JSON.stringify(link.own ?? {}) === before ? null : link;
  });
  return have;
}
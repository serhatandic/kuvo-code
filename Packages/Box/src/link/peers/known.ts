// @ts-nocheck
// Peers (PROTOCOL.md, "Peers")
// The other boxes a Mac set this one up with: itself and its other machines, each as that Mac's
// newest peers document names them, so one a Mac removed leaves every box it lists. And mail
// between them: sealed for one of them, and opened from one.

import { isObject } from "../../shared/json";
import { plainName } from "../../shared/text";
import { publicOf } from "../crypto/keys";
import { openOneWay, sealOneWay } from "../crypto/noise";
import { docKey, held, SIGN } from "../documents/format";
import { IS_MAC } from "../home";
import { Frame, frame, relaySend } from "../relay/frames";
import { macSign } from "../state";

export const KEY = /^[A-Za-z0-9_-]{43}$/;

export const ADDRESS = /^[A-Za-z0-9_-]{22}$/;

// The Macs that set this machine up (`setup`), whose documents and mail it takes.
export const macsOf = link => [...new Set([...(Array.isArray(link?.macs) ? link.macs : []), ...(typeof link?.mac === "string" ? [link.mac] : [])])];

// A Mac this machine hasn't heard from in 30 days, by its own clock (gone, or its key made anew):
// it's no longer one of its Macs, and its documents no longer count. One back sets the machine up
// again. `keep`, heard from now.
const MAC_GONE_AFTER = 30 * 24 * 3600 * 1000;
export function forgetOldMacs(link, keep, now = Date.now()) {
  link.macSeen ??= {};
  for (const mac of macsOf(link)) link.macSeen[mac] ??= now;
  if (keep) link.macSeen[keep] = now;
  const gone = macsOf(link).filter(mac => mac !== keep && now - link.macSeen[mac] > MAC_GONE_AFTER);
  if (!gone.length) return;
  for (const mac of gone) leaveMac(link, mac);
  if (gone.includes(link.mac)) link.mac = keep;
}

export function macDoc(link, mac, kind) {
  const sign = macSign(link, mac);
  return sign ? held(link.docs?.[docKey(sign, kind)]) : null;
}
// The phones documents this box takes now: its Macs' and its peers'.
export const phoneDocs = link => Object.values(link?.docs ?? {}).map(held).filter(doc => doc?.kind === "phones");

// A Mac that no longer counts here (it removed this machine, or wasn't heard from in 30 days): what
// it gave goes, and the phones it listed with it; another Mac's stay.
export function leaveMac(link, mac) {
  link.macs = macsOf(link).filter(each => each !== mac);
  if (link.mac === mac) {
    if (link.macs.length) link.mac = link.macs[0];
    else delete link.mac;
  }
  // COMPAT(beta.1 peers-list): `legacy`, a beta.1 Mac's list. Goes when 0.8.0 ships.
  for (const field of ["macSeen", "macSigns", "legacy"]) if (link[field]) delete link[field][mac];
  link.phones = (link.phones ?? []).filter(phone => !(phone.from === "mac" && phone.mac === mac));
}

export const MOST_PEERS = 64;
export const fitsPeer = peer => isObject(peer) && typeof peer.key === "string" && KEY.test(peer.key)
  && typeof peer.address === "string" && ADDRESS.test(peer.address) && (peer.kind === "mac" || peer.kind === "machine");
export const cleanPeer = ({ key, address, name, kind, id, sign }) => ({ key, address, kind, name: plainName(name).slice(0, 100), ...(typeof id === "string" ? { id: id.slice(0, 200) } : {}), ...(typeof sign === "string" && SIGN.test(sign) ? { sign } : {}) });
export const cleanMoved = moved => (Array.isArray(moved) ? moved : []).filter(each => isObject(each) && typeof each.session === "string" && /^ses_[A-Za-z0-9]{1,60}$/.test(each.session) && typeof each.key === "string" && KEY.test(each.key))
  .slice(0, 500).map(({ session, key }) => ({ session, key }));

// COMPAT(beta.1 peers-list): a beta.1 Mac's list of peers, as its peers document. Goes when 0.8.0 ships.
// A list of peers from a Mac that signs no documents yet (Kuvo Code 0.8.0-beta.1, PROTOCOL.md "For
// released Macs"): that Mac's newest, by its own `at`, used as its peers document would be, and
// never passed on. False when it isn't taken.
export function takeLegacyPeers(link, mac, peers, at, moved = []) {
  if (macSign(link, mac) || !Array.isArray(peers) || typeof at !== "number") return false;
  link.legacy ??= {};
  if (at <= (link.legacy[mac]?.at ?? 0)) return false;
  link.legacy[mac] = { at, peers: peers.filter(fitsPeer).slice(0, MOST_PEERS).map(cleanPeer), moved: cleanMoved(moved) };
  return true;
}

// Each of this box's Macs' word on its boxes: its peers document, or the list it gave before it
// signed them (`legacy`).
function macWords(link) {
  return macsOf(link).map(mac => {
    const doc = macDoc(link, mac, "peers");
    if (doc) return { boxes: Array.isArray(doc.body.boxes) ? doc.body.boxes.slice(0, MOST_PEERS) : [], moved: doc.body.moved };
    // COMPAT(beta.1 peers-list): a beta.1 Mac's list, in place of its peers document. Goes when 0.8.0 ships.
    return link?.legacy?.[mac] ? { boxes: link.legacy[mac].peers ?? [], moved: link.legacy[mac].moved } : null;
  }).filter(Boolean);
}

// Conversations a Mac moved from one box to another, by where each lives now (its box's key): the
// box it left may still list it, until it's back to let it go.
export function movedOf(link) {
  const moved = new Map();
  // This Mac's own word: what its app says (`kuvo/link/peers`).
  if (IS_MAC) {
    for (const { session, key } of cleanMoved(link?.macMoved)) moved.set(session, key);
    return moved;
  }
  for (const word of macWords(link)) for (const { session, key } of cleanMoved(word.moved)) moved.set(session, key);
  return moved;
}

// This box's peers now: every box its Macs name, itself left out.
export function peersOf(link) {
  if (!link) return [];
  // This Mac's box: its machines, as its app set them up (`kuvo/link/peers`).
  if (IS_MAC) return (Array.isArray(link.macPeers) ? link.macPeers : []).filter(fitsPeer).slice(0, MOST_PEERS).map(cleanPeer);
  const own = ownKey(link);
  const byKey = new Map();
  for (const word of macWords(link)) {
    for (const peer of word.boxes) if (fitsPeer(peer) && peer.key !== own && !byKey.has(peer.key)) byKey.set(peer.key, cleanPeer(peer));
  }
  return [...byKey.values()];
}

// This box's own public key, as peers name it.
export function ownKey(link) {
  try { return publicOf(Buffer.from(link.key, "base64url")).toString("base64url"); } catch { return null; }
}

// A mail frame's body opened: from one of this box's Macs, or one of its peers. `{sender, payload}`,
// or null for one from anyone else (or that isn't one).
export function openMail(body, link) {
  if (!link?.key) return null;
  const key = Buffer.from(link.key, "base64url");
  const senders = [...macsOf(link).map(mac => ({ key: mac, kind: "mac" })), ...peersOf(link).filter(peer => !macsOf(link).includes(peer.key))];
  for (const sender of senders) {
    try {
      const payload = JSON.parse(openOneWay(body, key, Buffer.from(sender.key, "base64url")).payload.toString("utf8"));
      return isObject(payload) ? { sender: peersOf(link).find(peer => peer.key === sender.key) ?? sender, payload } : null;
    } catch {}
  }
  return null;
}

// Mail for a peer, as the relay takes it, sealed for its key alone; null for one too big to go.
export function mailFor(peer, payload, link) {
  const sealed = frame(Frame.mail, 0, sealOneWay(Buffer.from(JSON.stringify(payload)), Buffer.from(link.key, "base64url"), Buffer.from(peer.key, "base64url")).message);
  if (sealed.length > MAX_MAIL) return null;
  return relaySend(Buffer.from(peer.address, "base64url"), sealed);
}
const MAX_MAIL = 65_600 - 17;

// Something to answer: a paired phone, a pairing code waiting, or other boxes of yours to talk to.
export const needed = link => Boolean(link && ((link.phones ?? []).length || (link.pairing && Date.now() < link.pairing.expires) || peersOf(link).length));
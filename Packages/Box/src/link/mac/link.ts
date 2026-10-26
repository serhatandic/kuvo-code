// @ts-nocheck
// This Mac's box's link (PROTOCOL.md, "This Mac's box: the relay")
// On a Mac, `serve` holds the relay connection a machine's `run` holds, in the same process: your
// phones' sessions, paired and pairing as on a machine, answered here. Its keys stay in your
// Keychain: the app gives them as the link starts (`link/identity`), and they're kept in memory
// only; without them the link stays off and says why, and never makes keys of its own. Its app says
// whether it's wanted (`kuvo/link/config`: the phone link on, machines to meet). Your other
// computers' mail is taken here, as a machine takes it: documents, agents, letters, group chats'.
// What a phone asks of the Mac's own routes, which only the app answers yet, goes to it through the
// host (`link/route`).
// Here: whether it's wanted, how it's doing, its keys, and the machines told they're let go;
// mac/relay runs it.

import { macPeersBody, ownDoc } from "../documents/work";
import { linkHost } from "../host-interface";
import { cleanPeer, fitsPeer, mailFor, peersOf } from "../peers/known";
import { macLink, readLink, updateLink } from "../state";

// Whether the link's wanted now: the phone link on, with a phone paired or a pairing waiting; or
// machines to meet.
export function macNeeded(link, now = Date.now()) {
  const config = macLink.config;
  if (!config) return false;
  if (config.machines) return true;
  const pairing = ["pairing", "appPairing"].some(slot => link?.[slot] && now < link[slot].expires);
  return Boolean(config.phones && ((link?.phones ?? []).length || pairing));
}

// Off the relay once it's no longer wanted (the phone link turned off, the last phone gone, a
// pairing that ran out, no machines any more).
export function macLinkCheck() {
  if (macLink.host && !macNeeded(readLink())) macLink.host.disconnect?.();
}

export function setLinkStatus(state, reason) {
  const next = reason ? { state, reason } : { state };
  if (JSON.stringify(next) === JSON.stringify(macLink.status)) return;
  macLink.status = next;
  for (const tell of macLink.statusFollowers) tell();
}

// Waits `ms`, or until the link's told something changed (`macLink.wake`).
export function macLinkWait(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      if (macLink.wake === done) macLink.wake = null;
      resolve();
    }
    macLink.wake = done;
  });
}

const KEY_TEXT = /^[A-Za-z0-9_-]{43}$/;

// This Mac's keys, from its app (your Keychain): its link key, relay secret and signing key, kept
// with the relay and name it says once it's on. False when the app couldn't give them (the link
// says so).
export async function macKeys() {
  const config = macLink.config;
  if (macLink.overlay || !config || !(config.phones || config.machines)) return true;
  const given = await linkHost("link/identity", {});
  if (!given || !["key", "secret", "sign"].every(name => KEY_TEXT.test(given[name] ?? ""))) {
    setLinkStatus("failed", "Kuvo Code couldn't give this Mac's link its keys from your Keychain. It tries again in a moment.");
    return false;
  }
  macLink.overlay = { key: given.key, secret: given.secret, sign: given.sign, relay: macLink.config.relay, name: macLink.config.name };
  // What it said of the keys before isn't so any more.
  if (macLink.status.state === "failed") setLinkStatus(macNeeded(readLink()) ? "connecting" : "off");
  return true;
}

// Machines this Mac removed hear its peers document once, while it still knows where they are: they
// let this Mac go. Those it couldn't tell now (off the relay, or the connection closing) hear it
// once it's back (`link.untold`), each kept until it went.
export function tellGone(gone) {
  if (!gone.length) return;
  const went = sendGone(gone);
  const left = gone.filter(peer => !went.includes(peer.key));
  updateLink(link => {
    if (!link) return null;
    const untold = (Array.isArray(link.untold) ? link.untold : []).filter(peer => !gone.some(each => each.key === peer.key));
    if (!left.length && untold.length === (link.untold?.length ?? 0)) return null;
    link.untold = [...untold, ...left].slice(-64);
    if (!link.untold.length) delete link.untold;
    return link;
  });
}

// Mails `gone` this Mac's peers document; the keys of those it went to.
function sendGone(gone) {
  const host = macLink.host;
  if (!host?.welcomed) return [];
  let envelope = null;
  const link = updateLink(link => {
    const made = link?.sign ? ownDoc(link, "peers", macPeersBody(link)) : null;
    envelope = made?.envelope ?? null;
    return made?.changed ? link : null;
  }) ?? readLink();
  if (!envelope || !link?.key) return [];
  const went = [];
  for (const peer of gone) {
    // (One that signs no documents takes none: nothing to tell it.)
    if (!peer.sign) {
      went.push(peer.key);
      continue;
    }
    const bytes = mailFor(peer, { docs: { give: [envelope] }, at: Date.now() }, link);
    try { if (bytes && host.send(bytes)) went.push(peer.key); } catch {}
  }
  return went;
}

// On the relay again: the machines removed meanwhile hear it now (one set up again since, not).
export function tellUntold() {
  const link = readLink();
  const untold = (Array.isArray(link?.untold) ? link.untold : []).filter(fitsPeer);
  const again = untold.filter(peer => peersOf(link).some(each => each.key === peer.key));
  if (again.length) {
    updateLink(link => {
      if (!link?.untold) return null;
      link.untold = link.untold.filter(peer => !again.some(each => each.key === peer.key));
      return link;
    });
  }
  tellGone(untold.filter(peer => !again.includes(peer)).map(cleanPeer));
}

// Stops it (a test's, as it ends): what's open goes, and the loop with it.
export function stopMacLink() {
  macLink.stopped = true;
  macLink.host?.disconnect?.();
  macLink.wake?.();
}
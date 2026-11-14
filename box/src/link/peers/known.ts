// Peers (PROTOCOL.md, "Peers")
// The other boxes a Mac set this one up with: itself and its other machines, each as that Mac's
// newest peers document names them, so one a Mac removed leaves every box it lists. Its Macs: those
// that set it up, each until it removes this box or isn't heard from in 30 days. And mail between
// them: sealed for one of them, and opened from one.

import type { Doc, DocKind } from "../../shared/documents";
import { isObject } from "../../shared/json";
import { plainName } from "../../shared/text";
import { publicOf } from "../crypto/keys";
import { openOneWay, sealOneWay } from "../crypto/noise";
import { docKey, held, SIGN } from "../documents/format";
import fs from "node:fs";
import path from "node:path";
import { IS_MAC, RUN } from "../home";
import { MOVED_FOR, movedAway } from "../moves/records";
import { Frame, frame, relaySend } from "../relay/frames";
import { setupDoc } from "../setup/record";
import { macSign, updateLink } from "../state";
import type { LinkState } from "../state";

/** A box a Mac names among its peers (PROTOCOL.md, "Documents": `peers`), as this box keeps it:
 * its static key and its address on the relay, what it is, its name, its id on that Mac, and its
 * signing key. */
export interface Peer {
  key: string;
  address: string;
  kind: "mac" | "machine";
  name: string;
  id?: string;
  sign?: string;
}

/** A peer as it's given, once `fitsPeer` has checked its key, address and kind: the rest is cleaned. */
export interface GivenPeer {
  key: string;
  address: string;
  kind: "mac" | "machine";
  name?: unknown;
  id?: unknown;
  sign?: unknown;
}

/** A conversation a Mac moved, by where it lives now (its box's key). */
export interface MovedSession {
  session: string;
  key: string;
}

/** Who sent a mail: one of this box's peers, or one of its Macs. */
export type MailSender = Peer | { key: string; kind: "mac" };

/** A mail opened (`openMail`): who sent it, and what it says. `vouched`: from a box only a peer
 * vouches for (`vouchedOf`), whose plan limits alone this box takes. */
export interface OpenedMail {
  sender: MailSender;
  payload: Record<string, unknown>;
  vouched?: true;
}

/** A Mac's word on its boxes: those it names, and the conversations it moved. */
interface MacWord {
  boxes: unknown[];
  moved: unknown;
}

export const KEY = /^[A-Za-z0-9_-]{43}$/;

export const ADDRESS = /^[A-Za-z0-9_-]{22}$/;

// The Macs that set this machine up (`setup`), whose documents and mail it takes.
export const macsOf = (link: LinkState | null | undefined): string[] => [...new Set([...(Array.isArray(link?.macs) ? link.macs : []), ...(typeof link?.mac === "string" ? [link.mac] : [])])];

// Only time this machine's box ran counts toward a Mac's 30 days: while it was off, no Mac could
// reach it, so a machine back after five weeks off keeps the Mac that writes second. Its last
// moment running is in run/online (a file of its own, so link.json isn't written each minute),
// noted every few minutes and as a Mac is heard from; a longer gap since was time off, and each
// Mac's last word moves on by it (back, by a clock set back, so the time between them stays).
// Without a note yet (a bridge from before), its last word from a Mac stands for it.
const ONLINE_FILE = path.join(RUN, "online");
const AWAY_AFTER = 5 * 60_000;
const notedOnline = (): number | undefined => {
  try {
    const at = Number(fs.readFileSync(ONLINE_FILE, "utf8"));
    return Number.isFinite(at) && at > 0 ? at : undefined;
  } catch {
    return undefined;
  }
};
const writeOnline = (now: number): void => {
  try {
    fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${ONLINE_FILE}.${process.pid}.tmp`, String(now), { mode: 0o600 });
    fs.renameSync(`${ONLINE_FILE}.${process.pid}.tmp`, ONLINE_FILE);
  } catch {}
};
// (Under link.json's lock: `forgetOldMacs` is, and `noteOnline` takes it.)
function countAway(link: LinkState, now: number): void {
  const seen = Object.values(link.macSeen ?? {});
  const last = notedOnline() ?? (seen.length ? Math.max(...seen) : undefined);
  const away = last === undefined ? 0 : now - last;
  if (Math.abs(away) > AWAY_AFTER && link.macSeen) for (const mac of Object.keys(link.macSeen)) link.macSeen[mac]! += away;
  writeOnline(now);
}

/** The box running (a machine's link, each minute): noted now and then, and where it was off
 * since (or its clock moved), its Macs' last words moved on by that. */
export function noteOnline(now = Date.now()): void {
  const last = notedOnline();
  if (last !== undefined && Math.abs(now - last) <= AWAY_AFTER) {
    if (now - last >= AWAY_AFTER / 2) writeOnline(now);
    return;
  }
  updateLink(link => {
    if (!link || !macsOf(link).length) return void writeOnline(now);
    countAway(link, now);
    return link;
  });
}

// A Mac this machine hasn't heard from in 30 days of its own time online (gone, or its key made
// anew): it's no longer one of its Macs, and its documents no longer count. One back sets the
// machine up again. `keep`, heard from now.
const MAC_GONE_AFTER = 30 * 24 * 3600 * 1000;
export function forgetOldMacs(link: LinkState, keep?: string, now = Date.now()): void {
  countAway(link, now);
  link.macSeen ??= {};
  for (const mac of macsOf(link)) link.macSeen[mac] ??= now;
  if (keep) link.macSeen[keep] = now;
  const gone = macsOf(link).filter(mac => mac !== keep && now - link.macSeen![mac]! > MAC_GONE_AFTER);
  if (!gone.length) return;
  for (const mac of gone) leaveMac(link, mac);
  if ((gone as (string | undefined)[]).includes(link.mac)) link.mac = keep;
}

// A Mac's own document of `kind`, as this box holds it (signed with that Mac's key), or null.
export function macDoc(link: LinkState | null | undefined, mac: string, kind: DocKind): Doc | null {
  const sign = macSign(link, mac);
  return sign ? held(link!.docs?.[docKey(sign, kind)]) : null;
}

// A Mac that no longer counts here (it removed this machine, or wasn't heard from in 30 days): what
// it gave goes, and the phones it listed with it; another Mac's stay.
export function leaveMac(link: LinkState, mac: string): void {
  link.macs = macsOf(link).filter(each => each !== mac);
  if (link.mac === mac) {
    if (link.macs.length) link.mac = link.macs[0];
    else delete link.mac;
  }
  // COMPAT(beta.1 peers-list): `legacy`, a beta.1 Mac's list. Goes when 0.8.0 ships.
  for (const field of ["macSeen", "macSigns", "macNames", "legacy"] as const) if (link[field]) delete link[field][mac];
  link.phones = (link.phones ?? []).filter(phone => !(phone.from === "mac" && phone.mac === mac));
  // The setup that Mac leads goes with it, as its peers document does (PROTOCOL.md, "Your setup").
  if (link.setup?.role === "member" && link.setup.primary === mac) delete link.setup;
}

export const MOST_PEERS = 64;
export const fitsPeer = (peer: unknown): peer is GivenPeer => isObject(peer) && typeof peer.key === "string" && KEY.test(peer.key)
  && typeof peer.address === "string" && ADDRESS.test(peer.address) && (peer.kind === "mac" || peer.kind === "machine");
export const cleanPeer = ({ key, address, name, kind, id, sign }: GivenPeer): Peer => ({ key, address, kind, name: plainName(name).slice(0, 100), ...(typeof id === "string" ? { id: id.slice(0, 200) } : {}), ...(typeof sign === "string" && SIGN.test(sign) ? { sign } : {}) });
export const cleanMoved = (moved: unknown): MovedSession[] => (Array.isArray(moved) ? moved : []).filter(each => isObject(each) && typeof each.session === "string" && /^ses_[A-Za-z0-9]{1,60}$/.test(each.session) && typeof each.key === "string" && KEY.test(each.key))
  .slice(0, 500).map(({ session, key }) => ({ session, key }));

// COMPAT(beta.1 peers-list): a beta.1 Mac's list of peers, as its peers document. Goes when 0.8.0 ships.
// A list of peers from a Mac that signs no documents yet (Kuvo Code 0.8.0-beta.1, PROTOCOL.md "For
// released Macs"): that Mac's newest, by its own `at`, used as its peers document would be, and
// never passed on. False when it isn't taken.
export function takeLegacyPeers(link: LinkState, mac: string, peers: unknown, at: unknown, moved: unknown = []): boolean {
  if (macSign(link, mac) || !Array.isArray(peers) || typeof at !== "number") return false;
  link.legacy ??= {};
  if (at <= (link.legacy[mac]?.at ?? 0)) return false;
  link.legacy[mac] = { at, peers: peers.filter(fitsPeer).slice(0, MOST_PEERS).map(cleanPeer), moved: cleanMoved(moved) };
  return true;
}

// Each of this box's Macs' word on its boxes: its peers document, or the list it gave before it
// signed them (`legacy`). In a setup, its main computer's word alone (PROTOCOL.md, "Your setup").
function macWords(link: LinkState | null | undefined): MacWord[] {
  const setup = setupDoc(link);
  if (setup) return [{ boxes: Array.isArray(setup.body.boxes) ? setup.body.boxes.slice(0, MOST_PEERS) : [], moved: setup.body.moved }];
  return macsOf(link).map(mac => {
    const doc = macDoc(link, mac, "peers");
    if (doc) return { boxes: Array.isArray(doc.body.boxes) ? doc.body.boxes.slice(0, MOST_PEERS) : [], moved: doc.body.moved };
    // COMPAT(beta.1 peers-list): a beta.1 Mac's list, in place of its peers document. Goes when 0.8.0 ships.
    return link?.legacy?.[mac] ? { boxes: link.legacy[mac].peers ?? [], moved: link.legacy[mac].moved } : null;
  }).filter(Boolean) as MacWord[];
}

// Conversations a Mac moved from one box to another, by where each lives now (its box's key): the
// box it left may still list it, until it's back to let it go.
export function movedOf(link: LinkState | null | undefined): Map<string, string> {
  const moved = new Map<string, string>();
  // COMPAT(beta.1 mac-moves): a Mac's word, from an app that ran moves before its boxes did. Goes when 0.8.0 ships.
  // A Mac's word: what this Mac's app says (`kuvo/link/peers`), or a Mac's peers document.
  if (IS_MAC) for (const { session, key } of cleanMoved(link?.macMoved)) moved.set(session, key);
  else for (const word of macWords(link)) for (const { session, key } of cleanMoved(word.moved)) moved.set(session, key);
  // Over it, the word of the box that moved each: this one's, and its peers'; the newest last.
  const now = Date.now();
  for (const { session, key } of [...movedAway(now), ...movesTold(link, now)].sort((one, other) => one.at - other.at)) moved.set(session, key);
  return moved;
}

/** What this box's peers (those it has now) say they moved in the last two days, never of one of
 * this box's own conversations. (The files are `directory.ts`' PEER_AGENTS_FILE and AGENTS_FILE,
 * which import this one.) */
export function movesTold(link: LinkState | null | undefined, now = Date.now()): { session: string; key: string; at: number }[] {
  const words: { session: string; key: string; at: number }[] = [];
  const peers = new Set(peersOf(link).map(peer => peer.key));
  const own = new Set(ownListed().map(agent => agent.session));
  try {
    const told = JSON.parse(fs.readFileSync(path.join(RUN, "peer-agents.json"), "utf8")) as Record<string, { moved?: unknown }>;
    for (const [peer, each] of Object.entries(told ?? {})) {
      if (!peers.has(peer) || !Array.isArray(each?.moved)) continue;
      words.push(...each.moved.filter((one): one is { session: string; key: string; at: number } => isObject(one) && typeof one.session === "string" && typeof one.key === "string"
        && typeof one.at === "number" && now - one.at < MOVED_FOR && !own.has(one.session)));
    }
  } catch {}
  return words;
}

/** The boxes you removed, so they're no peers of this one (`left`: this Mac's own record, or what
 * its Macs' peers documents say, or in a setup its main computer's), not those just missing from a
 * list for now. */
export function removedBoxes(link: LinkState | null | undefined): Set<string> {
  const setup = setupDoc(link);
  const left = IS_MAC ? (Array.isArray(link?.left) ? link.left : []) : (setup ? [setup] : macsOf(link).map(mac => macDoc(link, mac, "peers"))).flatMap(doc => {
    const named = doc?.body.left;
    return Array.isArray(named) ? named.filter((key): key is string => typeof key === "string") : [];
  });
  const peers = new Set(peersOf(link).map(peer => peer.key));
  return new Set(left.filter(key => !peers.has(key)));
}

/** This box's own agents as `run/agents.json` lists them: each one's session and name. */
export function ownListed(): { session: string; name: string | null }[] {
  try {
    const listed = JSON.parse(fs.readFileSync(path.join(RUN, "agents.json"), "utf8")) as { machine?: unknown; agents?: { session?: unknown; name?: unknown; machine?: unknown }[] };
    return (listed?.agents ?? []).filter(agent => (agent?.machine ?? null) === (listed?.machine ?? null))
      .map(agent => ({ session: String(agent?.session), name: typeof agent?.name === "string" ? agent.name : null }));
  } catch {
    return [];
  }
}

// This box's peers now: every box its Macs name, itself left out.
export function peersOf(link: LinkState | null | undefined): Peer[] {
  if (!link) return [];
  // This Mac's box: its machines, as its app set them up (`kuvo/link/peers`).
  if (IS_MAC) return (Array.isArray(link.macPeers) ? link.macPeers : []).filter(fitsPeer).slice(0, MOST_PEERS).map(cleanPeer);
  const own = ownKey(link);
  const byKey = new Map<string, Peer>();
  for (const word of macWords(link)) {
    for (const peer of word.boxes) if (fitsPeer(peer) && peer.key !== own && !byKey.has(peer.key)) byKey.set(peer.key, cleanPeer(peer));
  }
  return [...byKey.values()];
}

// This box's own public key, as peers name it.
export function ownKey(link: Pick<LinkState, "key">): string | null {
  // (One without a key throws, and has none.)
  try { return publicOf(Buffer.from(link.key!, "base64url")).toString("base64url"); } catch { return null; }
}

// A mail frame's body opened: from one of this box's Macs, or one of its peers. `{sender, payload}`,
// or null for one from anyone else (or that isn't one).
export function openMail(body: Buffer, link: LinkState | null | undefined, vouched: () => Peer[] = () => []): OpenedMail | null {
  if (!link?.key) return null;
  const key = Buffer.from(link.key, "base64url");
  const senders = [...macsOf(link).map(mac => ({ key: mac, kind: "mac" as const })), ...peersOf(link).filter(peer => !macsOf(link).includes(peer.key))];
  for (const sender of senders) {
    try {
      const payload = JSON.parse(openOneWay(body, key, Buffer.from(sender.key, "base64url")).payload.toString("utf8"));
      return isObject(payload) ? { sender: peersOf(link).find(peer => peer.key === sender.key) ?? sender, payload } : null;
    } catch {}
  }
  for (const sender of vouched()) {
    try {
      const payload = JSON.parse(openOneWay(body, key, Buffer.from(sender.key, "base64url")).payload.toString("utf8"));
      return isObject(payload) ? { sender, payload, vouched: true } : null;
    } catch {}
  }
  return null;
}

// Mail for a peer, as the relay takes it, sealed for its key alone; null for one too big to go, or
// for a box with no address this box knows (a Mac whose mail came before any peers document said
// where it is: nothing can go back to it yet).
export function mailFor(peer: Pick<Peer, "key"> & { address?: string }, payload: unknown, link: LinkState): Buffer | null {
  if (!peer.address) return null;
  const sealed = frame(Frame.mail, 0, sealOneWay(Buffer.from(JSON.stringify(payload)), Buffer.from(link.key!, "base64url"), Buffer.from(peer.key, "base64url")).message);
  if (sealed.length > MAX_MAIL) return null;
  return relaySend(Buffer.from(peer.address, "base64url"), sealed);
}
const MAX_MAIL = 65_600 - 17;

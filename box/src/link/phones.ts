// Paired phones (PROTOCOL.md, "Paired phones")
// A pairing adds a phone; a removal, from a phone on the list, takes one off for good (`removed`,
// with the pairing it ended): only a pairing of its own, with a new pairing id, lets it back in,
// and nobody removes a Mac. The phones this box pairs and removes are its own phones document; a
// Mac's come in that Mac's, and a removal in any document this box takes is noted here too
// (PROTOCOL.md, "Documents"). The Mac's are the same rules (PairedPhones in KuvoLink), and both
// are held to protocol/vectors/link.json.

import crypto from "node:crypto";
import { isObject } from "../shared/json";
import { addressOf, publicOf } from "./crypto/keys";
import { noteDocsChanged } from "./documents/changed";
import { mainElsewhere } from "./setup/main-only";
import { held } from "./documents/format";
import { ADDRESS, KEY, macDoc, macsOf } from "./peers/known";
import { readLink, updateLink } from "./state";
import type { Doc, SignedDoc } from "../shared/documents";
import type { PhoneHello } from "./relay/host";
import type { LinkState, Pairing, Phone } from "./state";

// Lets in phones in link.json, and a new one showing the pairing token (once, in time), noting
// where it is on the relay, for its notifications. Where a paired one is changes once its session
// proves its own (confirmPhone): the first handshake message can be replayed from elsewhere.
export function authorizePhone(key: Buffer, hello: PhoneHello | null | undefined, address: Buffer | undefined): boolean {
  const encoded = key.toString("base64url");
  if (!hello?.pair) return Boolean(readLink()?.phones?.some(phone => phone.key === encoded));
  // Showing the token: a pairing of its own, paired before or not (one removed comes back).
  let paired = false;
  updateLink(link => {
    // A phone's (`kuvo/phones/pair`), or, on a Mac, the one its Settings › Phone shows: each apart,
    // so neither ends the other.
    const given = Buffer.from(String(hello!.pair), "base64url");
    const slot = (["pairing", "appPairing"] as const).find(name => {
      const pairing = link?.[name];
      if (!pairing || Date.now() > pairing.expires) return false;
      const expected = Buffer.from(pairing.token, "base64url");
      return given.length === expected.length && crypto.timingSafeEqual(given, expected);
    });
    if (!slot) return null;
    // (A link made before this box joined a setup as a member: only its main computer pairs now.)
    if (mainElsewhere(link)) {
      delete link![slot];
      return link;
    }
    pairPhone(link!, { key: encoded, name: String(hello!.name ?? "").slice(0, 100), added: Math.floor(Date.now() / 1000), from: "pair", address: address?.toString("base64url"), pairing: newPairing() });
    delete link![slot];
    paired = true;
    return link;
  });
  if (paired) noteDocsChanged();
  return paired || Boolean(readLink()?.phones?.some(phone => phone.key === encoded));
}

const PAIRING = /^[A-Za-z0-9_-]{0,32}$/;

/** A phone named in a removal or a list, once `fits` has checked its key and pairing. */
export interface PhoneEntry {
  key: string;
  pairing?: string | null;
  [more: string]: unknown;
}

// At most so many in one removal, and so many removals kept (the oldest go first).
const MOST_AT_ONCE = 16;
const MOST_KEPT = 256;

const removedAlready = (link: LinkState, key: string, pairing: string) => (link.removed ?? []).some(r => r.key === key && r.pairing === pairing);

function noteRemoved(link: LinkState, key: string, pairing: string): void {
  link.removed ??= [];
  if (!removedAlready(link, key, pairing)) link.removed = [...link.removed, { key, pairing }].slice(-MOST_KEPT);
}

// A phone's key, and its pairing if given, as a removal or a list names it: never a Mac's.
// (`any`: a value off the wire, which it checks itself.)
export const fits = (entry: any, macs: string[]): entry is PhoneEntry => typeof entry?.key === "string" && KEY.test(entry.key) && !macs.includes(entry.key)
  && (entry.pairing == null || (typeof entry.pairing === "string" && PAIRING.test(entry.pairing)));

// `key`'s pairing `pairing` (the one it has here, when not given) taken off: one paired again
// since, with another pairing, stays.
function takeOff(link: LinkState, key: string, pairing?: string | null): void {
  const current = (link.phones ?? []).find(phone => phone.key === key);
  const which = pairing == null ? (current?.pairing ?? "") : String(pairing);
  noteRemoved(link, key, which);
  if (current && (current.pairing ?? "") === which) link.phones = link.phones!.filter(phone => phone.key !== key);
}

// A new pairing id, made where a phone pairs.
export const newPairing = () => crypto.randomBytes(12).toString("base64url");

// A phone paired here (its pairing token): in, with a pairing of its own, which nothing removed.
// What removed its others still keeps them out.
export function pairPhone(link: LinkState, phone: Phone): void {
  link.phones = [...(link.phones ?? []).filter(each => each.key !== phone.key), phone];
}

// Phones this Mac removes (its own box, from its app): Settings › Phone, or the removals a
// machine's phones document brought. Only phones; false, changing nothing, for anything else.
export function removeAsMac(link: LinkState, entries: unknown): boolean {
  if (!Array.isArray(entries) || !entries.length || entries.length > MOST_KEPT || !entries.every(entry => fits(entry, []))) return false;
  for (const entry of entries) takeOff(link, entry.key, entry.pairing);
  return true;
}

// Phones `by` removes ({key, pairing}): only a phone on the list, or a Mac, removes, and only
// phones, a few at a time. False, changing nothing, otherwise.
export function removePhones(link: LinkState, by: string | undefined, entries: unknown): boolean {
  const macs = macsOf(link);
  const allowed = new Set([...(link.phones ?? []).map(phone => phone.key), ...macs]);
  if (!allowed.has(by!) || !Array.isArray(entries) || !entries.length || entries.length > MOST_AT_ONCE) return false;
  if (!entries.every(entry => fits(entry, macs))) return false;
  for (const entry of entries) takeOff(link, entry.key, entry.pairing);
  return true;
}

// The phones this box lets in, from its documents (`link.phones`, which the rest reads): the ones
// each of its Macs lists in its phones document (or, for a Mac that hasn't signed one yet, as it
// listed them before), and the ones paired here, less every pairing removed in a document this box
// takes, which it notes as its own removal too, so it stays removed whatever becomes of that
// document. Each keeps when it was added here and where it was last seen.
export function foldPhones(link: LinkState, now = Date.now()): void {
  const macs = macsOf(link);
  for (const doc of phoneDocs(link)) {
    for (const entry of Array.isArray(doc.body.removed) ? doc.body.removed.slice(0, MOST_KEPT) : []) {
      if (fits(entry, macs) && typeof entry.pairing === "string") noteRemoved(link, entry.key, entry.pairing);
    }
  }
  const known = new Map((link.phones ?? []).map(phone => [phone.key, phone]));
  const signed = macs.filter(mac => macDoc(link, mac, "phones"));
  const listed: Phone[] = [];
  const add = (phone: Phone) => {
    if (!fits(phone, macs) || removedAlready(link, phone.key, phone.pairing ?? "") || listed.some(each => each.key === phone.key)) return;
    listed.push(phone);
  };
  for (const mac of macs) {
    const doc = macDoc(link, mac, "phones");
    if (!doc) {
      for (const phone of link.phones ?? []) if (phone.from === "mac" && phone.mac === mac) add(phone);
      continue;
    }
    for (const phone of Array.isArray(doc.body.phones) ? doc.body.phones.slice(0, 64) : []) {
      if (!isObject(phone)) continue;
      add({
        key: phone.key as string,
        name: String(phone.name ?? "").slice(0, 100),
        added: known.get(phone.key as string)?.added ?? Math.floor(now / 1000),
        from: "mac",
        mac,
        address: typeof phone.address === "string" && ADDRESS.test(phone.address) ? phone.address : known.get(phone.key as string)?.address,
        pairing: typeof phone.pairing === "string" ? phone.pairing : "",
      });
    }
  }
  // One from before Macs were named: kept until a Mac signs its phones.
  if (!signed.length) for (const phone of link.phones ?? []) if (phone.from === "mac" && phone.mac == null) add(phone);
  for (const phone of link.phones ?? []) if (phone.from === "pair") add(phone);
  link.phones = listed;
}

// This box's own phones document: the phones paired here, and every removal it knows of.
export const ownPhones = (link: LinkState) => ({
  phones: (link.phones ?? []).filter(phone => phone.from === "pair").map(phone => ({ key: phone.key, name: phone.name ?? "", ...(phone.address ? { address: phone.address } : {}), pairing: phone.pairing ?? "" })),
  removed: (link.removed ?? []).map(({ key, pairing }) => ({ key, pairing })),
});

// A phone's session proved its own: its notifications go where it is now.
export function confirmPhone(phone: { key: Buffer; address?: Buffer }): void {
  const where = phone.address?.toString("base64url");
  const known = readLink()?.phones?.find(each => each.key === phone.key.toString("base64url"));
  if (!known || !where || known.address === where) return;
  updateLink(link => {
    const known = link?.phones?.find(each => each.key === phone.key.toString("base64url"));
    if (!known || !where || known.address === where) return null;
    known.address = where;
    return link;
  });
}

// How long a pairing waits for its phone.
export const PAIRING_MINUTES = 10;

// A pairing's token, good once, for `PAIRING_MINUTES`.
export const newPairingToken = () => ({ token: crypto.randomBytes(16).toString("base64url"), expires: Date.now() + PAIRING_MINUTES * 60_000 });

// The link a phone pairs with, for `link`'s pairing.
export function pairingLink(link: LinkState & { relay: string; secret: string; key: string; name: string; pairing: Pairing }): string {
  const query = new URLSearchParams({
    v: "1",
    relay: link.relay,
    host: addressOf(Buffer.from(link.secret, "base64url")).toString("base64url"),
    key: publicOf(Buffer.from(link.key, "base64url")).toString("base64url"),
    token: link.pairing.token,
    name: link.name,
  });
  return `kuvo-link://pair?${query}`;
}

// The phones documents this box takes now: its Macs' and its peers'.
export const phoneDocs = (link: LinkState | null | undefined): Doc[] => (Object.values(link?.docs ?? {}) as SignedDoc[]).map(held).filter(doc => doc?.kind === "phones") as Doc[];

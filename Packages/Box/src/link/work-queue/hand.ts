// Items handed to a conversation on another computer (PROTOCOL.md, "The Work Queue", "Across your
// computers"): `queue_hand` to a session or bot that lives elsewhere. The item stays where it is,
// unchanged (`handing`), and goes by mail, whole, with its files, again each minute, until the box
// it went to says it has it; then it's gone from here. So it moves once: the box it goes to takes
// each hand-off once (by its id, and an item it has already is had), and one it can't take comes
// back with why, as a note. It's in the hander's view on every computer, as handed items are.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { plainName } from "../../shared/text";
import { locked, writePrivate } from "../files";
import { HERE } from "../home";
import { boxOf } from "../letters/calls";
import { placeOfSession } from "../letters/letter";
import { rootOf } from "../letters/tools";
import { frozen } from "../moves/records";
import { peersOf } from "../peers/known";
import { awaySince } from "../peers/reach";
import { readLink } from "../state";
import { categories, categoryNamed, keepCategory } from "./categories";
import { linkSession } from "./ops";
import {
  allItems, changeQueues, FILE_NAME, filesOf, itemOf, MOST_FILE, MOST_ITEMS, noteHanded, OWNER, placeIn, Refusal, WORK_QUEUE,
  type Book, type Item, type Who,
} from "./store";
import { mailsFor } from "./parts";
import { nameOf } from "./view";
import type { PeerPlaces } from "../engine/client";
import type { MailSender, Peer } from "../peers/known";
import type { LinkHost } from "../relay/host";
import type { LinkState } from "../state";
import type { Target } from "../../shared/records";

/** The bytes of files an item may take to another computer, all of them. */
export const MOST_HANDED_FILES = 4_000_000;
/** How long a hand-off waits for the box it goes to: then it's given up, and said. */
export const HAND_LIFE = 30 * 86_400_000;
const HAND_ID = /^wqh_[A-Za-z0-9_-]{8,40}$/;
const SEEN = path.join(WORK_QUEUE, "handed.json");
const SEEN_LOCK = path.join(WORK_QUEUE, ".handed.lock");

/** Where an item goes: the conversation (its queue's owner), the box it lives on, and its name. */
export interface Elsewhere { owner: string; peer: Peer; name: string }

const refuse = (words: string): never => { throw new Refusal(words); };

/** `item` set on its way to `to` on another computer: it stays here, unchanged, until that one has
 * it. Its files go with it, up to a few MB. */
export function handElsewhere(item: Item, to: Elsewhere, who: Who, now: number): void {
  if (item.handing) refuse(`${nameOf(item)} is on its way to ${item.handing.name || item.handing.to} already.`);
  let bytes = 0;
  for (const file of item.files) {
    try { bytes += fs.statSync(path.join(filesOf(item.id), file.name)).size; } catch {}
  }
  if (bytes > MOST_HANDED_FILES) refuse(`${nameOf(item)} keeps ${Math.round(bytes / 1_000_000)} MB of files: too much to hand to another computer (${Math.round(MOST_HANDED_FILES / 1_000_000)} MB at most). Take some away first (queue_update remove), or hand it to a session on ${HERE}.`);
  item.handing = { id: `wqh_${crypto.randomBytes(12).toString("base64url")}`, to: to.owner, key: to.peer.key, name: to.name, at: now, by: who };
}

// When each hand-off last went, and where, in this process: again each minute until it's had.
const sent = new Map<string, { at: number; key: string }>();

// What goes for `item`: it whole (without where it's going), its files' bytes, and the custom
// category it's in.
function handPayload(item: Item): Record<string, unknown> {
  const { handing, ...rest } = item;
  const files = item.files.flatMap(file => {
    try {
      return [{ name: file.name, data: fs.readFileSync(path.join(filesOf(item.id), file.name)).toString("base64") }];
    } catch {
      return [];
    }
  });
  const category = categories().find(each => each.id === item.category && !each.builtIn);
  return { hand: { id: handing!.id, to: handing!.to, from: item.owner, by: handing!.by, at: handing!.at, item: rest, files, ...(category ? { categories: [{ id: category.id, name: category.name }] } : {}) } };
}

/** The items on their way to another computer, sent (`across.ts`' rounds): to the box their
 * conversation lives on now, again each minute until it says it has them; given up after 30 days,
 * with a note. Nothing goes to a box that isn't answering. */
export function sendHandings(host: Pick<LinkHost, "send">, link: LinkState | null, targets: Target[], now = Date.now()): void {
  void targets;
  if (!link?.key) return;
  const handing = allItems().filter(item => item.handing && !item.removed);
  if (!handing.length) return;
  const peers = peersOf(link);
  const late = handing.filter(item => now - item.handing!.at > HAND_LIFE);
  if (late.length) giveBack(late.map(item => item.handing!.id), "it couldn't be reached for 30 days", now);
  for (const item of handing) {
    if (late.includes(item)) continue;
    const last = sent.get(item.handing!.id);
    if (last && now - last.at < 60_000) continue;
    // Where it lives now (it may have moved since), else where it was.
    const peer = boxOf(item.handing!.to, link) ?? peers.find(each => each.key === item.handing!.key);
    if (!peer || awaySince(peer.key) !== null) continue;
    const mails = mailsFor(peer, handPayload(item), link, now);
    if (!mails) {
      giveBack([item.handing!.id], "it's too big to send", now);
      continue;
    }
    try {
      for (const bytes of mails) host.send(bytes);
      sent.set(item.handing!.id, { at: now, key: peer.key });
    } catch {}
  }
}

/** Hand-offs that won't go, back as they were, each with a note of why. */
function giveBack(ids: string[], why: string, now: number): void {
  const gone = new Set(ids);
  changeQueues(book => {
    for (const item of book.items()) {
      if (!item.handing || !gone.has(item.handing.id)) continue;
      const { id, name, to, by } = item.handing;
      delete item.handing;
      item.notes.push({ at: now, by, text: `Couldn't be handed to ${name || to} on another computer: ${why.replace(/[.\s]+$/, "")}. It's still here.` });
      sent.delete(id);
    }
  }, now, { onItsOwn: true });
}

/** The box an item went to says how it went (`{handed: {id, ok, why?, retry?}}`), only from where it
 * was sent: had, it's gone from here, files and all; refused for good, it's back as it was, with a
 * note of why; `retry`, it goes again. */
export function handedBack(sender: MailSender, given: unknown, now = Date.now()): void {
  if (!isObject(given) || typeof given.id !== "string" || !HAND_ID.test(given.id)) return;
  const item = allItems().find(each => each.handing?.id === given.id);
  if (!item) return;
  const went = sent.get(given.id)?.key ?? item.handing!.key;
  if (went !== sender.key) return;
  if (given.retry === true) return void sent.delete(given.id);
  if (given.ok !== true) return giveBack([given.id], typeof given.why === "string" ? plainName(given.why).slice(0, 300) || "it was refused" : "it was refused", now);
  sent.delete(given.id);
  changeQueues(book => {
    const found = book.find({ id: item.id });
    if (!found || found.handing?.id !== given.id) return;
    book.queue(found.owner).items = book.queue(found.owner).items.filter(each => each.id !== found.id);
  }, now, { onItsOwn: true });
  if (!allItems().some(each => each.id === item.id)) fs.rmSync(filesOf(item.id), { recursive: true, force: true });
}

// Hand-offs taken here, by id, remembered 30 days: one sent again is had, never taken twice.
function seenHand(id: string, now: number, note = false): boolean {
  try {
    fs.mkdirSync(WORK_QUEUE, { recursive: true, mode: 0o700 });
    return locked(SEEN_LOCK, () => {
      let seen: Record<string, number> = {};
      try { seen = JSON.parse(fs.readFileSync(SEEN, "utf8")) ?? {}; } catch {}
      if (!note) return id in seen;
      for (const [key, at] of Object.entries(seen)) if (now - at > HAND_LIFE) delete seen[key];
      seen[id] = now;
      writePrivate(SEEN, JSON.stringify(seen));
      return true;
    });
  } catch {
    return false;
  }
}

/** A hand-off from another computer (`{hand: …}`) for a conversation here: taken once, into its
 * queue (its root conversation's), linked to it, with its files; answered `{handed: {id, ok}}`, or
 * why not (`retry` while this box can't tell yet, or the conversation is moving). */
export async function handArrived(sender: MailSender, given: unknown, reply: (payload: Record<string, unknown>) => void, places: () => PeerPlaces, now = Date.now()): Promise<void> {
  if (!isObject(given) || typeof given.id !== "string" || !HAND_ID.test(given.id) || typeof given.to !== "string" || !/^ses_[A-Za-z0-9]{1,60}$/.test(given.to)) return;
  const id = given.id;
  const answer = (ok: boolean, why?: string, retry = false) => reply({ handed: { id, ok, ...(why ? { why } : {}), ...(retry ? { retry: true } : {}) } });
  if (!peersOf(readLink()).some(peer => peer.key === sender.key)) return;
  if (seenHand(id, now)) return answer(true);
  const from = typeof given.from === "string" && OWNER.test(given.from) ? given.from : null;
  const item = itemOf(given.item, given.to);
  if (!item || !from) return answer(false, "That isn't an item.");
  if (frozen().has(given.to)) return answer(false, "That conversation is moving between computers: it comes again once it's there.", true);
  const { targets, bridge } = places();
  let root: Awaited<ReturnType<typeof rootOf>> = null;
  try {
    if (!(await placeOfSession(given.to, targets))) return answer(false, `There's no conversation ${given.to} on ${HERE}.`, !bridge);
    root = await rootOf(given.to, targets);
  } catch {
    return answer(false, `${HERE} can't look up its conversations now.`, true);
  }
  const owner = root?.session ?? given.to;
  if (root?.place.data.metadata?.kuvo?.seat) return answer(false, "That's a group chat's seat: hand it to the bot's own conversation.");
  // The files that came with it: names it keeps, sizes it takes.
  const files = (Array.isArray(given.files) ? given.files : []).flatMap(each => {
    if (!isObject(each) || typeof each.name !== "string" || !FILE_NAME.test(each.name) || typeof each.data !== "string") return [];
    const bytes = Buffer.from(each.data, "base64");
    return bytes.length <= MOST_FILE ? [{ name: each.name, bytes }] : [];
  });
  item.files = item.files.filter(file => files.some(each => each.name === file.name));
  for (const each of Array.isArray(given.categories) ? given.categories : []) if (isObject(each) && typeof each.id === "string" && typeof each.name === "string") keepCategory(each.id, each.name);
  const by: Who = isObject(given.by) && given.by.user !== true && typeof given.by.session === "string" && typeof given.by.name === "string" ? { session: given.by.session, name: plainName(given.by.name).slice(0, 100) } : { user: true };
  let refused: string | null = null;
  changeQueues((book: Book) => {
    if (book.find({ id: item.id })) return;
    if (book.queue(owner).items.filter(each => !each.removed && each.category !== "done").length >= MOST_ITEMS) {
      refused = `That queue has ${MOST_ITEMS} open items already.`;
      return;
    }
    if (!categoryNamed(item.category)) item.category = "next";
    item.owner = owner;
    item.order = placeIn(book.items(), item.category);
    delete item.removed;
    book.queue(owner).items.push(item);
    noteHanded(item, from, owner, now);
    if (owner.startsWith("ses_") && item.category !== "done") linkSession(book, item, owner, now);
    item.updated = { at: now, by };
    fs.rmSync(filesOf(item.id), { recursive: true, force: true });
    for (const file of files) {
      fs.mkdirSync(filesOf(item.id), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(filesOf(item.id), file.name), file.bytes, { mode: 0o600 });
    }
  }, now, { onItsOwn: true });
  if (refused) return answer(false, refused);
  seenHand(id, now, true);
  answer(true);
}

/** Where `to` (a session's address, or a bot's name) lives, when it isn't on this computer: the box
 * that told of it, its peer that takes the Work Queue's mail. Null when none says. */
export function elsewhereOf(session: string, link: LinkState | null = readLink()): Peer | null {
  return boxOf(session, link);
}

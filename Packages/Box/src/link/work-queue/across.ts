// The Work Queue across your computers (PROTOCOL.md, "The Work Queue", "Across your computers"):
// one list for everything. Each box tells every other its items (summaries, the owners they name,
// its custom categories and how it numbers) as they change, unasked, so the All view and a lead's
// view on any computer have them, as of when they were told, while that one sleeps; each goes again
// each minute until that computer says it has it. Mail too big for one goes in parts. Numbers' asks
// and blocks, and items handed to another computer's conversations (`hand.ts`), come through here.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { plainName } from "../../shared/text";
import { IS_MAC } from "../home";
import { readPeerAgents } from "../peers/directory";
import { ownKey, peersOf, removedBoxes } from "../peers/known";
import { awaySince } from "../peers/reach";
import { readLink } from "../state";
import { categories, keepCategory } from "./categories";
import { handArrived, handedBack, sendHandings } from "./hand";
import { mailsFor, takePart } from "./parts";
import { movePast, ownSince, primaryOf, takeNumbersMail, topOf } from "./numbers";
import { allItems, OWNER, queueFollowers, WORK_QUEUE, type Item } from "./store";
import { forgetTold, keepTold, MOST_TOLD, MOST_TOLD_DONE, readTold, TOLD, toldKeys, toldOf, type Numbering, type ToldItem } from "./told";
import { factsOf, ownersOf, summaryOf, type Computer, type OwnerFacts } from "./view";
import { rowsOf } from "../work/elsewhere";
import type { PeerPlaces } from "../engine/client";
import type { MailSender, Peer } from "../peers/known";
import type { LinkHost } from "../relay/host";
import type { LinkState } from "../state";
import type { Target } from "../../shared/records";

/** What a box's agents' mail says when it takes the Work Queue from its peers (`kuvo/info`'s
 * `features` too). */
export const QUEUES_FEATURE = "work-queue.elsewhere";

/** Whether the computer `key` takes the Work Queue's mail. */
export const takesQueues = (key: string): boolean => (readPeerAgents()[key]?.features ?? []).includes(QUEUES_FEATURE);

/** What a computer is called in the Work Queue: a machine by its name, a Mac by its own. */
export const computerName = (peer: Pick<Peer, "kind" | "name" | "id">): string => (peer.kind === "mac" ? plainName(peer.name) || "the Mac" : peer.id || plainName(peer.name) || "another computer");

// ---- Telling ----

/** What this box tells its peers of its Work Queue now: its id (the same while it is), and what. */
interface Telling {
  id: string;
  payload: Record<string, unknown>;
}

/** How this box numbers, as it tells its peers: its kind, when it was set up, the highest number it
 * used or holds, and its primary (itself, or another, with when that one was set up). */
export function numberingNow(link: LinkState | null): Numbering {
  const primary = primaryOf(link);
  const own = link ? ownKey(link) : null;
  const kind = IS_MAC ? "mac" : "machine";
  const since = ownSince();
  let named: Numbering["primary"];
  if ("self" in primary) named = own ? { key: own, kind, since } : undefined;
  else if ("peer" in primary) {
    const told = primary.via ? readTold(primary.via.key)?.primary?.since : readTold(primary.peer.key)?.since;
    named = { key: primary.peer.key, kind: primary.peer.kind, ...(told ? { since: told } : {}) };
  }
  return { kind, since, top: topOf(), ...(named ? { primary: named } : {}) };
}

/** An item as this box tells it: its summary, with who handed it on. */
const toldItem = (item: Item, working: Set<string>, titles: Map<string, { title: string }>): ToldItem => {
  const summary = summaryOf(item, working, titles);
  const from = [...new Set((item.handed ?? []).map(each => each.from))];
  return { ...summary, ...(summary.lastNote ? { lastNote: { ...summary.lastNote, text: summary.lastNote.text.slice(0, 500) } } : {}), ...(from.length ? { handedFrom: from } : {}) };
};

/** What this box tells of its Work Queue now: its items (not deleted ones; the latest Done ones
 * only), the owners they name, its custom categories, and how it numbers. */
export async function tellingNow(targets: Target[], link: LinkState | null, signal?: AbortSignal, cache?: Map<string, unknown>): Promise<Telling> {
  const facts = await factsOf(targets, signal);
  const all = allItems().filter(item => OWNER.test(item.owner) && !item.removed);
  const done = all.filter(item => item.category === "done").sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0)).slice(0, MOST_TOLD_DONE);
  const items = [...all.filter(item => item.category !== "done").sort((a, b) => b.updated.at - a.updated.at).slice(0, MOST_TOLD - done.length), ...done];
  const { owners, titles } = await ownersOf("all", items, facts, targets, cache);
  const told = items.map(item => toldItem(item, facts.working, titles));
  const custom = categories().filter(each => !each.builtIn).map(({ id, name }) => ({ id, name }));
  const content = { items: told, owners, categories: custom, ...numberingNow(link) };
  const id = "wqt_" + crypto.createHash("sha256").update(JSON.stringify(content)).digest("base64url").slice(0, 22);
  return { id, payload: { told: { id, at: Date.now(), ...content } } };
}

// What this box last told each computer: the id, whether it said it has it, and when it last went.
const pushed = new Map<string, { id: string; done: boolean; sent: number }>();
let telling: Telling | null = null;
let builtAt = -Infinity;
let builtMarks = "";
let building = false;
/** The least time between two tellings to one computer, however busy. */
export const TELL_SPACING = 15_000;
const marks = () => [path.join(WORK_QUEUE, "queues"), path.join(WORK_QUEUE, "categories.json"), path.join(WORK_QUEUE, "numbers.json"), TOLD].map(file => {
  try { return String(fs.statSync(file).mtimeMs); } catch { return "-"; }
}).join(" ");
// Titles of sessions the list doesn't have, looked up once in ten minutes at most.
let titles = new Map<string, unknown>();
let titlesAt = 0;

/** This box's Work Queue told to each computer that takes it, on its rounds: worked out again when
 * a queue changes, and each minute (who's at work changes it too); to one computer once in 15
 * seconds at most, again each minute until it says it has it, and nothing while it's the same and
 * had; nothing while that computer isn't answering. Then the items it's handing to another
 * computer's conversations go (`hand.ts`). */
export async function pushQueues(host: Pick<LinkHost, "send">, link: LinkState | null = readLink(), targets: Target[], now = Date.now()): Promise<void> {
  if (!link?.key || building) return;
  const peers = peersOf(link);
  // What's kept of computers you removed goes.
  const removed = removedBoxes(link);
  for (const key of toldKeys()) if (removed.has(key)) forgetTold(key);
  // (Nothing to work out while no computer takes it.)
  if (!peers.some(peer => takesQueues(peer.key))) return;
  const changed = marks();
  if (!telling || changed !== builtMarks || now - builtAt > 60_000) {
    building = true;
    try {
      if (now - titlesAt > 600_000) {
        titles = new Map();
        titlesAt = now;
      }
      telling = await tellingNow(targets, link, undefined, titles);
      builtAt = now;
      builtMarks = changed;
    } catch {
      // (Its engine can't say now: as it was, until it can.)
      return;
    } finally {
      building = false;
    }
  }
  for (const peer of peers) {
    if (!takesQueues(peer.key) || awaySince(peer.key) !== null) continue;
    const before = pushed.get(peer.key);
    if (before?.id === telling.id && (before.done || now - before.sent < 60_000)) continue;
    if (before && before.id !== telling.id && now - before.sent < TELL_SPACING) continue;
    const mails = mailsFor(peer, telling.payload, link, now);
    if (!mails) continue;
    try {
      for (const bytes of mails) host.send(bytes);
      pushed.set(peer.key, { id: telling.id, done: false, sent: now });
    } catch {}
  }
  sendHandings(host, link, targets, now);
}

/** A computer answers again: what's changed goes at the next round. */
export function queuesBack(key: string): void {
  const before = pushed.get(key);
  if (before && !before.done) pushed.set(key, { ...before, sent: 0 });
}

/** Told again from the start (a test's, or a box that asks for agents: it may have missed it). */
export function tellQueuesAgain(key?: string): void {
  if (key) pushed.delete(key);
  else pushed.clear();
}

/** What a computer told of its Work Queue, kept (unless what's kept is newer), and said to be had;
 * the primary moves its counter past the numbers it uses; a box takes the custom categories of the
 * primary it numbers from. */
function takeTold(sender: MailSender, given: unknown, reply: (payload: Record<string, unknown>) => void): void {
  const told = toldOf(given);
  if (!told) return;
  const link = readLink();
  // (Only from one of your computers that's still a peer: a Mac that set this one up is one.)
  if (!peersOf(link).some(peer => peer.key === sender.key)) return;
  keepTold(sender.key, told);
  reply({ had: told.id });
  const primary = primaryOf(link);
  if ("self" in primary) movePast(Math.max(told.top ?? 0, ...told.items.map(item => item.number ?? 0)));
  else if ("peer" in primary && primary.peer.key === sender.key) for (const each of told.categories) keepCategory(each.id, each.name);
  for (const tell of queueFollowers) tell();
}

/** The Work Queue's mail from another computer (`{workQueue: …}`): a part of one too big for one
 * mail, what it tells of its queue and that it has this box's, numbers' asks and blocks, and items
 * handed between them. */
export async function takeWorkQueueMail(sender: MailSender, given: unknown, host: Pick<LinkHost, "send"> | null | undefined, places: () => PeerPlaces): Promise<void> {
  if (!isObject(given)) return;
  const whole = isObject(given.part) ? takePart(sender, given.part) : given;
  if (!whole) return;
  const reply = (payload: Record<string, unknown>) => {
    const link = readLink();
    const to = peersOf(link).find(peer => peer.key === sender.key);
    const mails = link && to ? mailsFor(to, payload, link) : null;
    if (mails) try { for (const bytes of mails) host?.send(bytes); } catch {}
  };
  if (isObject(whole.ask) || isObject(whole.give)) takeNumbersMail(sender, whole, host);
  if (isObject(whole.told)) takeTold(sender, whole.told, reply);
  if (typeof whole.had === "string") {
    const before = pushed.get(sender.key);
    if (before?.id === whole.had) pushed.set(sender.key, { ...before, done: true });
  }
  if (isObject(whole.handed)) handedBack(sender, whole.handed);
  if (isObject(whole.hand)) await handArrived(sender, whole.hand, reply, places).catch(() => {});
}


// ---- Reading what others told ----

/** An item another computer told of, with which one. */
export type ItemElsewhere = ToldItem & { computer: Computer };

/** Your other computers' items that `owner`'s view has (`all`: every one), as each last told them:
 * those of the sessions it oversees there (their rows, "Work"), those it handed on, its own; with
 * the owners they name, their custom categories, and when each computer told them. Items this box
 * has itself (one on its way here, say) are left to it. */
export function itemsElsewhere(owner: string, link: LinkState | null = readLink(), here: Set<string> = new Set(allItems().map(item => item.id))): {
  items: ItemElsewhere[];
  owners: OwnerFacts[];
  categories: { id: string; name: string }[];
  computers: (Computer & { at: number })[];
} {
  const overseen = owner === "all" ? null : new Set(rowsOf(owner).flatMap(each => each.rows.map(row => row.session)));
  const items: ItemElsewhere[] = [];
  const owners = new Map<string, OwnerFacts>();
  const custom = new Map<string, string>();
  const computers: (Computer & { at: number })[] = [];
  const seen = new Set(here);
  for (const peer of peersOf(link)) {
    const told = readTold(peer.key);
    if (!told) continue;
    const computer: Computer = { key: peer.key, name: computerName(peer), kind: peer.kind, ...(peer.id ? { id: peer.id } : {}) };
    computers.push({ ...computer, at: told.at });
    for (const item of told.items) {
      if (seen.has(item.id)) continue;
      if (overseen && item.owner !== owner && !overseen.has(item.owner) && item.handedBy !== owner && !item.handedFrom?.includes(owner)) continue;
      seen.add(item.id);
      items.push({ ...item, computer });
    }
    for (const each of told.owners) if (!owners.has(each.owner)) owners.set(each.owner, each);
    for (const each of told.categories) if (!custom.has(each.id)) custom.set(each.id, each.name);
  }
  const named = new Set(items.flatMap(item => [item.owner, ...(item.handedBy ? [item.handedBy] : [])]));
  return { items, owners: [...owners.values()].filter(each => named.has(each.owner)), categories: [...custom].map(([id, name]) => ({ id, name })), computers };
}

/** The item another computer told of that `ref` names (by id or number), or null. */
export function itemElsewhere(ref: { id: string } | { number: number }, link: LinkState | null = readLink()): ItemElsewhere | null {
  for (const peer of peersOf(link)) {
    const found = readTold(peer.key)?.items.find(item => ("id" in ref ? item.id === ref.id : item.number === ref.number));
    if (found) return { ...found, computer: { key: peer.key, name: computerName(peer), kind: peer.kind, ...(peer.id ? { id: peer.id } : {}) } };
  }
  return null;
}

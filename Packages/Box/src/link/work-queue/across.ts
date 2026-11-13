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
import { awaySince, readReach } from "../peers/reach";
import { readLink } from "../state";
import { categories, takePrimaryCategories } from "./categories";
import { handArrived, handedBack, sendHandings } from "./hand";
import { actForPeer } from "./acts";
import { takeAct, takeActed } from "./forward";
import { mailsFor, takePart } from "./parts";
import { movePast, ownSince, primaryOf, takeNumbersMail, topOf } from "./numbers";
import { sharedMachine } from "../setup/settle";
import { noteSetupNow } from "../setup/lead";
import { allItems, OWNER, queueFollowers, refNames, WORK_QUEUE, type Item, type ItemRef } from "./store";
import { doneByRead, SEEN_FILE, seenOf, withSeen } from "./github";
import { forgetTold, keepTold, MOST_TOLD, MOST_TOLD_DONE, patchTold, readTold, TOLD, toldItemOf, toldKeys, toldOf, type Numbering, type ToldItem } from "./told";
import { locked, writePrivate } from "../files";
import { factsOf, linkedTo, ownersOf, summaryOf, type Computer, type OwnerFacts } from "./view";
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
 * used or holds, its primary (itself, or another, with when that one was set up), and whether it's a
 * machine Macs share outside one setup (said by every box that knows setups). */
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
  return { kind, since, top: topOf(), ...(named ? { primary: named } : {}), shared: sharedMachine(link) };
}

/** An item as this box tells it: its summary, with who handed it on; an issue's with when this
 * box last asked GitHub of it (`seen.checked`), so another computer reads it only once that's old. */
const toldItem = (item: Item, working: Set<string>, titles: Map<string, { title: string }>): ToldItem => {
  const summary = summaryOf(item, working, titles);
  const from = [...new Set((item.handed ?? []).map(each => each.from))];
  const read = summary.seen ? seenOf(item.source) : undefined;
  const checked = read ? read.checked ?? read.at : undefined;
  return { ...summary, ...(summary.lastNote ? { lastNote: { ...summary.lastNote, text: summary.lastNote.text.slice(0, 500) } } : {}), ...(from.length ? { handedFrom: from } : {}),
    ...(summary.seen && checked !== undefined ? { seen: { ...summary.seen, checked } } : {}) };
};

/** What this box tells of its Work Queue now: its items (not deleted ones; the latest Done ones
 * only), the owners they name, its custom categories, and how it numbers. */
export async function tellingNow(targets: Target[], link: LinkState | null, signal?: AbortSignal, cache?: Map<string, unknown>): Promise<Telling> {
  const facts = await factsOf(targets, signal);
  const all = allItems().filter(item => OWNER.test(item.owner) && !item.removed);
  // (An issue closed on GitHub is Done here too: among the latest Done, not the open ones.)
  const isDone = (item: Item) => item.category === "done" || Boolean(item.source && doneByRead(seenOf(item.source)));
  // (When it was Done: an issue Done on GitHub, when it was closed there or, gone, since when, as
  // clients show it; it has no Done time of its own here.)
  const doneTime = (item: Item) => {
    const read = item.source ? seenOf(item.source) : undefined;
    return read?.value && doneByRead(read) ? read.value.closedAt ?? read.at : item.doneAt ?? 0;
  };
  const done = all.filter(isDone).sort((a, b) => doneTime(b) - doneTime(a)).slice(0, MOST_TOLD_DONE);
  const items = [...all.filter(item => !isDone(item)).sort((a, b) => b.updated.at - a.updated.at).slice(0, MOST_TOLD - done.length), ...done];
  const { owners, titles } = await ownersOf("all", items, facts, targets, cache);
  const told = items.map(item => toldItem(item, facts.working, titles));
  const custom = categories().filter(each => !each.builtIn).map(({ id, name }) => ({ id, name }));
  const content = { items: told, owners, categories: custom, ...numberingNow(link) };
  // (When GitHub was last asked of an issue goes with it, so the others don't ask again meanwhile,
  // but isn't a change: what's told goes again only once something else changes.)
  const unchecked = { ...content, items: told.map(item => (item.seen?.checked !== undefined ? { ...item, seen: { ...item.seen, checked: undefined } } : item)) };
  const id = "wqt_" + crypto.createHash("sha256").update(JSON.stringify(unchecked)).digest("base64url").slice(0, 22);
  return { id, payload: { told: { id, at: Date.now(), ...content } } };
}

// What this box last told each computer: the id, whether it said it has it, and when it last went.
const pushed = new Map<string, { id: string; done: boolean; sent: number; soon?: boolean }>();
let telling: Telling | null = null;
let builtAt = -Infinity;
let builtMarks = "";
let building = false;
/** The least time between two tellings to one computer, however busy. */
export const TELL_SPACING = 15_000;
const marks = () => [path.join(WORK_QUEUE, "queues"), path.join(WORK_QUEUE, "categories.json"), path.join(WORK_QUEUE, "numbers.json"), TOLD, SEEN_FILE].map(file => {
  try { return String(fs.statSync(file).mtimeMs); } catch { return "-"; }
}).join(" ");
// Titles of sessions the list doesn't have, looked up once in ten minutes at most.
let titles = new Map<string, unknown>();
let titlesAt = 0;

/** This box's Work Queue told to each computer that takes it, on its rounds: worked out again when
 * a queue changes, and each minute (who's at work changes it too); to one computer once in 15
 * seconds at most, again each minute until it says it has it, and nothing while it's the same and
 * had; nothing while that computer isn't answering. The items it's handing to another computer's
 * conversations go first (`hand.ts`), whatever's told. */
export async function pushQueues(host: Pick<LinkHost, "send">, link: LinkState | null = readLink(), targets: Target[], now = Date.now()): Promise<void> {
  if (!link?.key) return;
  const peers = peersOf(link);
  // What's kept of computers you removed goes.
  const removed = removedBoxes(link);
  for (const key of toldKeys()) if (removed.has(key)) forgetTold(key);
  sendHandings(host, link, targets, now);
  // (Nothing to work out while no computer takes it.)
  if (building || !peers.some(peer => takesQueues(peer.key))) return;
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
    // (Had: nothing while it's the same. Never two to one computer within 15 seconds; the same one
    // again after a minute, or sooner when this box's queue was changed from a client.)
    if (before?.id === telling.id && before.done) continue;
    if (before && now - before.sent < TELL_SPACING) continue;
    if (before?.id === telling.id && !before.soon && now - before.sent < 60_000) continue;
    const mails = fittedMails(peer, telling, link, now);
    if (!mails) continue;
    try {
      for (const bytes of mails) host.send(bytes);
      pushed.set(peer.key, { id: telling.id, done: false, sent: now });
    } catch {}
  }
}

// What's told, as mails for `peer`: whole, or, too big even in parts, with its items cut (Done ones
// and the longest unchanged first: they're last in the list), said in the box's log.
function fittedMails(peer: Peer, telling: Telling, link: LinkState, now: number): Buffer[] | null {
  const told = telling.payload.told as { items: unknown[] } & Record<string, unknown>;
  for (const most of [told.items.length, 1000, 500, 200, 50]) {
    if (most > told.items.length) continue;
    const mails = mailsFor(peer, most === told.items.length ? telling.payload : { told: { ...told, items: told.items.slice(0, most) } }, link, now);
    if (mails) {
      if (most < told.items.length) console.error(`Work Queue: ${told.items.length} items were too many to tell ${computerName(peer)} at once: told the ${most} latest.`);
      return mails;
    }
  }
  console.error(`Work Queue: what this box tells ${computerName(peer)} is too big to send, even cut to its 50 latest items.`);
  return null;
}

/** A computer answers again: what's changed goes at the next round. */
export function queuesBack(key: string): void {
  const before = pushed.get(key);
  if (before && !before.done) pushed.set(key, { ...before, sent: 0 });
}

/** Told again: to `key` from the start (a box that asks for agents: it may have missed it); to every
 * computer, what it hasn't said it has, at the next round rather than after a minute (a change from
 * a client), never sooner than 15 seconds after the last. */
export function tellQueuesAgain(key?: string): void {
  if (key) return void pushed.delete(key);
  for (const [each, before] of pushed) if (!before.done) pushed.set(each, { ...before, soon: true });
}

/** All that was told forgotten (a test's). */
export function forgetPushed(): void {
  pushed.clear();
}

/** What a computer told of its Work Queue, kept (unless what's kept is newer) and said to be had;
 * the primary moves its counter past the numbers it uses; a box takes the custom categories of the
 * primary it numbers from (from the peer it reaches it through, one that numbers from it too). */
function takeTold(sender: MailSender, given: unknown, reply: (payload: Record<string, unknown>) => void): void {
  const told = toldOf(given);
  if (!told) return;
  const link = readLink();
  // (Only from one of your computers that's still a peer: a Mac that set this one up is one.)
  if (!peersOf(link).some(peer => peer.key === sender.key)) return;
  // (What came late, older than what's kept, isn't had: had, it would never go again.)
  const before = readTold(sender.key);
  if (!keepTold(sender.key, told)) return;
  forgetDeletedThere(new Set(told.items.map(item => item.id)));
  reply({ had: told.id });
  // How it numbers changed (it's shared now, or numbers from another): this box's setup looked at now.
  if (before?.shared !== told.shared || before?.primary?.key !== told.primary?.key || before?.primary?.since !== told.primary?.since) noteSetupNow(Date.now(), { soon: 0 });
  const primary = primaryOf(link);
  if ("self" in primary) movePast(Math.max(told.top ?? 0, ...told.items.map(item => item.number ?? 0)));
  else if ("peer" in primary && (primary.via ? primary.via.key === sender.key && told.primary?.key === primary.peer.key : primary.peer.key === sender.key)) {
    // (Read only when a category it no longer has is one this box might keep.)
    let counts: Map<string, number> | null = null;
    takePrimaryCategories(told.categories, id => {
      if (!counts) {
        counts = new Map();
        for (const item of allItems()) counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
      }
      return counts.get(id) ?? 0;
    });
  }
  for (const tell of queueFollowers) tell();
}

/** The Work Queue's mail from another computer (`{workQueue: …}`): a part of one too big for one
 * mail, what it tells of its queue and that it has this box's, numbers' asks and blocks, items
 * handed between them, and what a client did to an item one keeps, handed on by the box it asked
 * (`forward.ts`), and its answer. */
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
  if (isObject(whole.acted)) takeActed(sender, whole.acted);
  if (isObject(whole.act)) await takeAct(sender, whole.act, reply, act => actForPeer(act, places().targets)).catch(() => {});
}


// ---- Reading what others told ----

/** An item another computer told of, with which one. */
export type ItemElsewhere = ToldItem & { computer: Computer };

/** Your other computers' items that `owner`'s view has (`all`: every one), as each last told them:
 * those of the sessions it oversees there (their rows, "Work"), those it handed on, its own, and
 * with `linked` those linked to it (what it's working on, for its view to show: never what its
 * tools may change); with the owners they name, their custom categories, and when each computer
 * told them. Items this box has itself (`here`: one on its way here, say) are left to it; one
 * deleted here (`deleted`) is theirs, unless they told of it on its way here. */
export function itemsElsewhere(owner: string, link: LinkState | null = readLink(), here?: Set<string>, deleted?: Set<string>, { asTold = false, linked = false }: { asTold?: boolean; linked?: boolean } = {}): {
  items: ItemElsewhere[];
  owners: OwnerFacts[];
  categories: { id: string; name: string }[];
  computers: (Computer & { at: number; away?: number })[];
} {
  if (!here || !deleted) {
    const all = allItems();
    here ??= new Set(all.filter(item => !item.removed).map(item => item.id));
    deleted ??= new Set(all.filter(item => item.removed).map(item => item.id));
  }
  const overseen = owner === "all" ? null : new Set(rowsOf(owner).flatMap(each => each.rows.map(row => row.session)));
  const owners = new Map<string, OwnerFacts>();
  const custom = new Map<string, string>();
  const computers: (Computer & { at: number; away?: number })[] = [];
  // (An item two computers told of, one handed between them and the first not told again yet: the
  // newer word, so a stale copy never hides the live one.)
  const best = new Map<string, { item: ItemElsewhere; at: number }>();
  const reach = readReach();
  for (const peer of peersOf(link)) {
    const told = readTold(peer.key);
    if (!told) continue;
    const computer: Computer = { key: peer.key, name: computerName(peer), kind: peer.kind, ...(peer.id ? { id: peer.id } : {}) };
    const away = awaySince(peer.key, reach);
    computers.push({ ...computer, at: told.at, ...(away !== null ? { away } : {}) });
    for (const item of told.items) {
      // (Not one here; nor one deleted here that this one told of on its way here: it got here.)
      if (here.has(item.id) || (deleted.has(item.id) && item.handing)) continue;
      const other = best.get(item.id);
      if (!other || newer(item, told.at, other.item, other.at)) best.set(item.id, { item: asTold ? { ...item, computer } : withSeen({ ...asAway(item, away), computer }), at: told.at });
    }
    for (const each of told.owners) if (!owners.has(each.owner)) owners.set(each.owner, each);
    for (const each of told.categories) if (!custom.has(each.id)) custom.set(each.id, each.name);
  }
  const items = [...best.values()].map(each => each.item)
    .filter(item => !overseen || item.owner === owner || overseen.has(item.owner) || item.handedBy === owner || item.handedFrom?.includes(owner) || (linked && linkedTo(owner, item)));
  const named = new Set(items.flatMap(item => [item.owner, ...(item.handedBy ? [item.handedBy] : [])]));
  return { items, owners: [...owners.values()].filter(each => named.has(each.owner)), categories: [...custom].map(([id, name]) => ({ id, name })), computers };
}

/** The item another computer told of that `ref` names (by id, number or source), or null: of two,
 * the newer word. With `deleted`, one you deleted there through this box that none tells of now, as
 * that box answered (`removed`): for bringing it back there (Undo) and reading it, only. */
export function itemElsewhere(ref: ItemRef, link: LinkState | null = readLink(), { asTold = false, deleted = false }: { asTold?: boolean; deleted?: boolean } = {}): ItemElsewhere | null {
  let found: { item: ItemElsewhere; at: number } | null = null;
  const peers = peersOf(link);
  const computerOf = (peer: Peer): Computer => ({ key: peer.key, name: computerName(peer), kind: peer.kind, ...(peer.id ? { id: peer.id } : {}) });
  for (const peer of peers) {
    const told = readTold(peer.key);
    const item = told?.items.find(each => refNames(ref, each));
    if (item && (!found || newer(item, told!.at, found.item, found.at))) found = { item: { ...(asTold ? item : asAway(item, awaySince(peer.key))), computer: computerOf(peer) }, at: told!.at };
  }
  if (!found && deleted) {
    for (const [, each] of Object.entries(readDeletedThere())) {
      const peer = peers.find(one => one.key === each.key);
      const item = toldItemOf(each.item);
      if (peer && item && refNames(ref, item)) return { ...item, removed: { at: each.at, by: { user: true } }, computer: computerOf(peer) };
    }
  }
  return found ? (asTold ? found.item : withSeen(found.item)) : null;
}

// Items you deleted on another computer through this box (`run/work-queue/deleted-there.json`, by
// id: the computer's key, when, and the item as its box answered), for Undo: a day, 200 at most,
// and only until that computer, or this box, has it again.
const DELETED_THERE = path.join(WORK_QUEUE, "deleted-there.json");
const DELETED_LOCK = path.join(WORK_QUEUE, ".deleted-there.lock");
const DELETED_FOR = 86_400_000;
type DeletedThere = Record<string, { key: string; at: number; item: unknown }>;

function readDeletedThere(now = Date.now()): DeletedThere {
  try {
    const kept: unknown = JSON.parse(fs.readFileSync(DELETED_THERE, "utf8"));
    if (!isObject(kept)) return {};
    const here = new Set(allItems().map(item => item.id));
    return Object.fromEntries(Object.entries(kept).filter(([id, each]) => isObject(each) && typeof each.key === "string" && typeof each.at === "number" && now - each.at < DELETED_FOR && !here.has(id))) as DeletedThere;
  } catch {
    return {};
  }
}

// The latest 200 kept, or the file gone when none are.
function keepDeletedThere(entries: [string, DeletedThere[string]][]): void {
  if (!entries.length) return void fs.rmSync(DELETED_THERE, { force: true });
  writePrivate(DELETED_THERE, JSON.stringify(Object.fromEntries(entries.sort(([, a], [, b]) => b.at - a.at).slice(0, 200))));
}

// What's kept of items deleted there, gone for those a computer tells of again (brought back).
// (Its ids looked at first, as they're written: most tellings name none of them.)
function forgetDeletedThere(told: Set<string>): void {
  let ids: string[];
  try {
    const kept: unknown = JSON.parse(fs.readFileSync(DELETED_THERE, "utf8"));
    ids = isObject(kept) ? Object.keys(kept) : [];
  } catch {
    return;
  }
  if (!ids.some(id => told.has(id))) return;
  try {
    locked(DELETED_LOCK, () => keepDeletedThere(Object.entries(readDeletedThere()).filter(([id]) => !told.has(id))));
  } catch {}
}

/** A change you made through this box to an item the computer `key` keeps, as its box answered
 * (`item`): what this box has of it now, so its views show it at once, not when that computer next
 * tells (one deleted is gone from them, and kept for bringing back there). */
export function changedThere(key: string, action: "delete" | "move" | "restore", item: Record<string, unknown>, now = Date.now()): void {
  const id = typeof item.id === "string" ? item.id : null;
  if (!id) return;
  patchTold(key, id, item, action === "delete");
  if (action !== "delete" && !fs.existsSync(DELETED_THERE)) return;
  try {
    locked(DELETED_LOCK, () => {
      const kept = readDeletedThere(now);
      if (action === "delete") kept[id] = { key, at: now, item };
      else delete kept[id];
      keepDeletedThere(Object.entries(kept));
    });
  } catch {}
  for (const tell of queueFollowers) tell();
}

// An item told by a computer that isn't answering (`away`, since when): as it told it, but with
// none of its sessions said to be at work, as nothing there can be seen at work now.
const asAway = (item: ToldItem, away: number | null): ToldItem =>
  away === null || (!item.inProgress && !item.sessions.some(each => each.working)) ? item : { ...item, inProgress: false, sessions: item.sessions.map(each => ({ ...each, working: false })) };

// Whether `a` (told at `aAt`) is newer word of an item than `b`: changed later, or the same and
// told later.
const newer = (a: ToldItem, aAt: number, b: ToldItem, bAt: number): boolean => a.updated.at > b.updated.at || (a.updated.at === b.updated.at && aAt > bAt);

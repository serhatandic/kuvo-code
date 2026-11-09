// The Work Queue's items (PROTOCOL.md, "The Work Queue"): each conversation's queue of work, kept on
// the box it lives on, the same on a Mac's box and a machine's. A queue is its owner's, by key: a
// conversation (`ses_…`, a bot's or a session's) or a group chat (`grp_…`). Kept in
// `run/work-queue/queues/<owner>.json`, every change under one lock for the whole folder, so a
// hand-off from one queue to another is one step; pictures and files an agent attached in
// `run/work-queue/files/<item>/`. What's deleted stays 30 days for an undo.
//
// (Named apart from `engine/queue.ts`, which is a conversation's queue of messages.)

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { listOf, locked, textOf, writePrivate } from "../files";
import { RUN } from "../home";

export const WORK_QUEUE = path.join(RUN, "work-queue");
const QUEUES = path.join(WORK_QUEUE, "queues");
export const FILES = path.join(WORK_QUEUE, "files");
const LOCK = path.join(WORK_QUEUE, ".lock");

/** An owner's key: a conversation's address, or a group chat's id. */
export const OWNER = /^(?:ses_[A-Za-z0-9]{1,60}|grp_[a-z0-9]{1,60})$/;
export const ITEM_ID = /^wqi_[A-Za-z0-9_-]{20}$/;
const SESSION = /^ses_[A-Za-z0-9]{1,60}$/;

/** How long a deleted item can be brought back. */
export const KEPT_REMOVED = 30 * 86_400_000;
export const MOST_ITEMS = 2000;
export const MOST_TITLE = 200;
export const MOST_BODY = 100_000;
export const MOST_NOTE = 20_000;
export const MOST_NOTES = 200;
export const MOST_FILE = 25_000_000;
export const MOST_FILES = 50;
export const MOST_LINKS = 50;
const MOST_HANDED = 20;

/** Who did something: you, from a client, or an agent (its conversation and name). */
export type Who = { user: true } | { session: string; name: string };

export interface Note { at: number; by: Who; text: string }
export interface KeptFile { name: string; size: number; type: string; at: number }
export interface Link { url: string; title?: string }
export interface Linked { session: string; since: number }
export interface Handed { from: string; to: string; at: number }

/** One item, as it's kept. */
export interface Item {
  id: string;
  number?: number;
  owner: string;
  title: string;
  body: string;
  category: string;
  order: number;
  progress?: { value?: number; note?: string };
  notes: Note[];
  files: KeptFile[];
  links: Link[];
  sessions: Linked[];
  handed?: Handed[];
  /** The first owner that handed it on: it stays in that one's view for good. */
  handedBy?: string;
  /** A number it was imported with, until the primary grants it. */
  wanted?: number;
  source?: { kind: string; ref: string; url?: string };
  created: { at: number; by: Who };
  updated: { at: number; by: Who };
  doneAt?: number;
  removed?: { at: number; by: Who };
}

/** An owner's queue, as its file keeps it. */
export interface Queue {
  owner: string;
  items: Item[];
}

/** Those following the queues in this process: told at once of a change made here. */
export const queueFollowers = new Set<() => void>();

const fileOf = (owner: string) => path.join(QUEUES, `${owner}.json`);

export const newItemID = () => `wqi_${crypto.randomBytes(15).toString("base64url")}`;

const whoOf = (given: unknown): Who | null => {
  if (!isObject(given)) return null;
  if (given.user === true) return { user: true };
  return typeof given.session === "string" && typeof given.name === "string" ? { session: given.session, name: given.name } : null;
};

// An item as it was read, checked: null for one that isn't.
function itemOf(given: unknown, owner: string): Item | null {
  if (!isObject(given) || typeof given.id !== "string" || !ITEM_ID.test(given.id) || typeof given.title !== "string" || typeof given.category !== "string") return null;
  const created = isObject(given.created) && typeof given.created.at === "number" ? { at: given.created.at, by: whoOf(given.created.by) ?? { user: true } as Who } : { at: 0, by: { user: true } as Who };
  const updated = isObject(given.updated) && typeof given.updated.at === "number" ? { at: given.updated.at, by: whoOf(given.updated.by) ?? created.by } : created;
  const list = <T>(value: unknown, keep: (each: Record<string, unknown>) => boolean): T[] => (Array.isArray(value) ? value.filter(each => isObject(each) && keep(each)) as T[] : []);
  return {
    id: given.id,
    ...(typeof given.number === "number" && Number.isInteger(given.number) && given.number > 0 ? { number: given.number } : {}),
    owner,
    title: given.title,
    body: typeof given.body === "string" ? given.body : "",
    category: given.category,
    order: typeof given.order === "number" && Number.isFinite(given.order) ? given.order : 0,
    ...(isObject(given.progress) ? { progress: { ...(typeof given.progress.value === "number" ? { value: given.progress.value } : {}), ...(typeof given.progress.note === "string" ? { note: given.progress.note } : {}) } } : {}),
    notes: list<Note>(given.notes, each => typeof each.at === "number" && typeof each.text === "string" && whoOf(each.by) !== null),
    files: list<KeptFile>(given.files, each => typeof each.name === "string" && typeof each.size === "number"),
    links: list<Link>(given.links, each => typeof each.url === "string"),
    sessions: list<Linked>(given.sessions, each => typeof each.session === "string" && SESSION.test(each.session)),
    ...(Array.isArray(given.handed) ? { handed: list<Handed>(given.handed, each => typeof each.from === "string" && typeof each.to === "string") } : {}),
    ...(typeof given.handedBy === "string" && OWNER.test(given.handedBy) ? { handedBy: given.handedBy } : {}),
    ...(typeof given.wanted === "number" && Number.isInteger(given.wanted) && given.wanted > 0 ? { wanted: given.wanted } : {}),
    ...(isObject(given.source) && typeof given.source.kind === "string" && typeof given.source.ref === "string" ? { source: given.source as Item["source"] } : {}),
    created,
    updated,
    ...(typeof given.doneAt === "number" ? { doneAt: given.doneAt } : {}),
    ...(isObject(given.removed) && typeof given.removed.at === "number" ? { removed: { at: given.removed.at, by: whoOf(given.removed.by) ?? { user: true } } } : {}),
  };
}

/** An owner's queue as it's kept (empty for one with none). */
export function readQueue(owner: string): Queue {
  const kept = (() => {
    try {
      return JSON.parse(textOf(fileOf(owner)) ?? "null");
    } catch {
      return null;
    }
  })();
  const items = isObject(kept) && Array.isArray(kept.items) ? kept.items.map(each => itemOf(each, owner)).filter((each): each is Item => each !== null) : [];
  return { owner, items };
}

/** The owners with a queue here. */
export function owners(): string[] {
  return listOf(QUEUES).filter(name => name.endsWith(".json")).map(name => name.slice(0, -5)).filter(owner => OWNER.test(owner));
}

/** Every queue here. */
export const readAll = (): Queue[] => owners().map(readQueue);

/** Every item here, of every owner (deleted ones too). */
export const allItems = (): Item[] => readAll().flatMap(queue => queue.items);

/** The queues here as one change sees them: each read once, written back if it changed. */
export class Book {
  private readonly queues = new Map<string, Queue>();
  private readonly before = new Map<string, string>();

  constructor() {
    for (const owner of owners()) this.load(owner);
  }

  private load(owner: string): Queue {
    let queue = this.queues.get(owner);
    if (!queue) {
      queue = readQueue(owner);
      this.queues.set(owner, queue);
      this.before.set(owner, JSON.stringify(queue.items));
    }
    return queue;
  }

  /** An owner's queue (made when it has none). */
  queue(owner: string): Queue {
    return this.load(owner);
  }

  /** Every item, of every owner. */
  items(): Item[] {
    return [...this.queues.values()].flatMap(queue => queue.items);
  }

  /** The item with this id or number, and its queue. */
  find(ref: { id?: string; number?: number }): Item | null {
    return this.items().find(item => (ref.id ? item.id === ref.id : item.number === ref.number)) ?? null;
  }

  /** `item` moved into `owner`'s queue. */
  give(item: Item, owner: string): void {
    const from = this.load(item.owner);
    from.items = from.items.filter(each => each.id !== item.id);
    item.owner = owner;
    this.load(owner).items.push(item);
  }

  /** What changed, written. */
  save(): boolean {
    let any = false;
    for (const [owner, queue] of this.queues) {
      const now = JSON.stringify(queue.items);
      if (now === this.before.get(owner)) continue;
      any = true;
      if (!queue.items.length) fs.rmSync(fileOf(owner), { force: true });
      else writePrivate(fileOf(owner), JSON.stringify({ owner, items: queue.items }));
      this.before.set(owner, now);
    }
    return any;
  }
}

/** `work` done on the queues here, one process at a time; what it changed written, and those
 * following told. Deleted items past their 30 days go first (and their files). */
export function changeQueues<T>(work: (book: Book) => T, now = Date.now()): T {
  fs.mkdirSync(WORK_QUEUE, { recursive: true, mode: 0o700 });
  const { value, changed } = locked(LOCK, () => {
    const book = new Book();
    for (const queue of owners().map(owner => book.queue(owner))) {
      const gone = queue.items.filter(item => item.removed && now - item.removed.at > KEPT_REMOVED);
      if (!gone.length) continue;
      queue.items = queue.items.filter(item => !gone.includes(item));
      for (const item of gone) fs.rmSync(path.join(FILES, item.id), { recursive: true, force: true });
    }
    const value = work(book);
    return { value, changed: book.save() };
  });
  if (changed) noteQueuesChanged();
  return value;
}

/** Those following told of a change (made here, or by another process: its files say so too). */
export function noteQueuesChanged(): void {
  for (const tell of queueFollowers) tell();
}

/** The folder an item's files are kept in. */
export const filesOf = (item: string) => path.join(FILES, item);

/** The place at the end of a category (or its start, `top`), among every owner's items here. */
export function placeIn(items: Item[], category: string, { top = false }: { top?: boolean } = {}): number {
  const orders = items.filter(item => item.category === category && !item.removed).map(item => item.order);
  if (!orders.length) return 0;
  return top ? Math.min(...orders) - 1 : Math.max(...orders) + 1;
}

/** The place just before (or after) `beside` in its category. */
export function placeBeside(items: Item[], beside: Item, after: boolean): number {
  const sorted = items.filter(item => item.category === beside.category && !item.removed && item.id !== beside.id).map(item => item.order).sort((a, b) => a - b);
  const neighbor = after ? sorted.find(order => order > beside.order) : [...sorted].reverse().find(order => order < beside.order);
  return neighbor === undefined ? beside.order + (after ? 1 : -1) : (beside.order + neighbor) / 2;
}

/** A note of who handed an item to whom, the last few kept. */
export function noteHanded(item: Item, from: string, to: string, at: number): void {
  item.handedBy ??= from;
  item.handed = [...(item.handed ?? []), { from, to, at }].slice(-MOST_HANDED);
}

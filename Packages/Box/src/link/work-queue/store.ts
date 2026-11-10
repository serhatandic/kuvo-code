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
/** A queue file's owner as a newer box may name one (another kind than this box knows): its queue is
 * kept as it is, and goes along, never skipped or written over. */
export const KEPT_OWNER = /^[a-z]{2,10}_[A-Za-z0-9_-]{1,80}$/;
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

/** Who did something: you, from a client, an agent (its conversation and name), or someone this box
 * doesn't know the shape of (an outside tracker's change, `{source, name?}`, from a newer box), kept
 * as it was. */
export type Who = { user: true } | { session: string; name: string } | OtherWho;
export interface OtherWho { [key: string]: unknown; name?: string; source?: string }

/** Who, in words: "the user", an agent's name, or another's (a tracker's change). */
export const whoWords = (who: Who): string => {
  const given = who as Record<string, unknown>;
  if (given.user === true) return "the user";
  if (typeof given.name === "string" && given.name) return given.name;
  return typeof given.source === "string" && given.source ? given.source : "someone else";
};
/** Whether it was you. */
export const byUser = (who: Who): boolean => (who as Record<string, unknown>).user === true;

export interface Note { at: number; by: Who; text: string }
export interface KeptFile { name: string; size: number; type: string; at: number }
/** An outside link; `kind` (`pr`, `mr`, `issue`, `doc`) and `ref` kept for outside sources later. */
export interface Link { url: string; title?: string; kind?: string; ref?: string }
/** A session linked to an item; `box` where it runs, when that's another computer (kept as given). */
export interface Linked { session: string; since: number; box?: string }
export interface Handed { from: string; to: string; at: number }
/** An outside source's item (an issue or a pull request): never numbered, named by `ref`. */
export interface Source { kind: string; ref: string; url?: string; host?: string; id?: string }
/** An item on its way to a conversation on another computer (`hand.ts`): it stays here, unchanged,
 * until that computer has it. */
export interface Handing { id: string; to: string; key: string; name: string; at: number; by: Who; sent?: number; missing?: number }

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
  /** The number it was imported with, where that was another item's, and it has a new one. */
  importedAs?: number;
  source?: Source;
  /** On its way to a conversation on another computer. */
  handing?: Handing;
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

// Who, as it was kept: you, an agent, or any other shape (an outside tracker's, a newer box's) kept
// as it is, small values only, so a box that doesn't know it never turns it into you or drops it.
export const whoOf = (given: unknown): Who | null => {
  if (!isObject(given)) return null;
  if (given.user === true) return { user: true };
  if (typeof given.session === "string" && typeof given.name === "string") return { session: given.session, name: given.name };
  const kept = Object.fromEntries(Object.entries(given).filter(([key, value]) => key.length <= 40 && (typeof value === "string" ? value.length <= 200 : typeof value === "number" || typeof value === "boolean")).slice(0, 10));
  return Object.keys(kept).length ? kept as Who : null;
};

/** A file's name as an item keeps it: a name of its own, never a path. */
export const FILE_NAME = /^(?!\.\.?$)[^/\\\0]{1,200}$/;

// What this box knows of an item: every other field a newer box wrote is kept as it was.
const KNOWN = new Set(["id", "number", "owner", "title", "body", "category", "order", "progress", "notes", "files", "links", "sessions", "handed", "handedBy", "wanted", "importedAs", "source", "handing", "created", "updated", "doneAt", "removed"]);

const handingOf = (given: unknown): Handing | null => {
  if (!isObject(given) || typeof given.id !== "string" || !/^wqh_[A-Za-z0-9_-]{8,40}$/.test(given.id) || typeof given.to !== "string" || !OWNER.test(given.to)
    || typeof given.key !== "string" || typeof given.at !== "number") return null;
  return { id: given.id, to: given.to, key: given.key, name: typeof given.name === "string" ? given.name : "", at: given.at, by: whoOf(given.by) ?? { user: true }, ...(typeof given.sent === "number" ? { sent: given.sent } : {}), ...(typeof given.missing === "number" ? { missing: given.missing } : {}) };
};

/** An item as it was read (or as a move brought it), checked: null for one that isn't. Fields this
 * box doesn't know (a newer box's) are kept as they are, so writing it here doesn't drop them. */
export function itemOf(given: unknown, owner: string): Item | null {
  if (!isObject(given) || typeof given.id !== "string" || !ITEM_ID.test(given.id) || typeof given.title !== "string" || typeof given.category !== "string") return null;
  const created = isObject(given.created) && typeof given.created.at === "number" ? { at: given.created.at, by: whoOf(given.created.by) ?? { user: true } as Who } : { at: 0, by: { user: true } as Who };
  const updated = isObject(given.updated) && typeof given.updated.at === "number" ? { at: given.updated.at, by: whoOf(given.updated.by) ?? created.by } : created;
  const list = <T>(value: unknown, keep: (each: Record<string, unknown>) => boolean): T[] => (Array.isArray(value) ? value.filter(each => isObject(each) && keep(each)) as T[] : []);
  const unknown = Object.fromEntries(Object.entries(given).filter(([key]) => !KNOWN.has(key)));
  return {
    ...unknown,
    id: given.id,
    ...(typeof given.number === "number" && Number.isInteger(given.number) && given.number > 0 ? { number: given.number } : {}),
    owner,
    title: given.title,
    body: typeof given.body === "string" ? given.body : "",
    category: given.category,
    order: typeof given.order === "number" && Number.isFinite(given.order) ? given.order : 0,
    ...(isObject(given.progress) ? { progress: { ...(typeof given.progress.value === "number" ? { value: given.progress.value } : {}), ...(typeof given.progress.note === "string" ? { note: given.progress.note } : {}) } } : {}),
    notes: list<Note>(given.notes, each => typeof each.at === "number" && typeof each.text === "string" && whoOf(each.by) !== null),
    files: list<KeptFile>(given.files, each => typeof each.name === "string" && FILE_NAME.test(each.name) && typeof each.size === "number"),
    links: list<Link>(given.links, each => typeof each.url === "string"),
    sessions: list<Linked>(given.sessions, each => typeof each.session === "string" && SESSION.test(each.session)),
    ...(Array.isArray(given.handed) ? { handed: list<Handed>(given.handed, each => typeof each.from === "string" && typeof each.to === "string") } : {}),
    ...(typeof given.handedBy === "string" && OWNER.test(given.handedBy) ? { handedBy: given.handedBy } : {}),
    ...(typeof given.wanted === "number" && Number.isInteger(given.wanted) && given.wanted > 0 ? { wanted: given.wanted } : {}),
    ...(typeof given.importedAs === "number" && Number.isInteger(given.importedAs) && given.importedAs > 0 ? { importedAs: given.importedAs } : {}),
    ...(isObject(given.source) && typeof given.source.kind === "string" && typeof given.source.ref === "string" ? { source: given.source as unknown as Source } : {}),
    ...(handingOf(given.handing) ? { handing: handingOf(given.handing)! } : {}),
    created,
    updated,
    ...(typeof given.doneAt === "number" ? { doneAt: given.doneAt } : {}),
    ...(isObject(given.removed) && typeof given.removed.at === "number" ? { removed: { at: given.removed.at, by: whoOf(given.removed.by) ?? { user: true } } } : {}),
  };
}

/** A queue file that's there but isn't one (cut short, changed by hand): `aside` true. Or one that
 * can't be read just now (too many files open, a disk error): left where it is. */
export class UnreadableQueue extends Error {
  constructor(readonly owner: string, readonly aside: boolean) {
    super(`${owner}'s Work Queue file can't be read`);
  }
}

/** An owner's queue as it's kept: empty for one with none; `UnreadableQueue` for a file that's
 * there but can't be read as one, never read as empty (a change would write over what it holds). */
export function readQueue(owner: string): Queue {
  const file = fileOf(owner);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { owner, items: [] };
    throw new UnreadableQueue(owner, false);
  }
  let kept: unknown;
  try {
    kept = JSON.parse(text);
  } catch {
    throw new UnreadableQueue(owner, true);
  }
  if (!isObject(kept) || !Array.isArray(kept.items)) throw new UnreadableQueue(owner, true);
  // (An item twice in one file: once.)
  const seen = new Set<string>();
  const items = kept.items.map(each => itemOf(each, owner)).filter((each): each is Item => each !== null && !seen.has(each.id) && seen.add(each.id) !== undefined);
  return { owner, items };
}

/** A queue file that isn't one, moved aside (`queues/aside/`), so it's kept for a person to look at
 * and the owner's queue starts again empty: where it went, or null when it couldn't be moved. */
export function setAside(owner: string, now = Date.now()): string | null {
  const aside = path.join(QUEUES, "aside", `${owner}-${now}.json`);
  try {
    fs.mkdirSync(path.dirname(aside), { recursive: true, mode: 0o700 });
    fs.renameSync(fileOf(owner), aside);
    return aside;
  } catch {
    return null;
  }
}

/** The words for a change refused over `error`'s file, set aside first where it isn't a queue. */
function refusedOver(error: UnreadableQueue, now: number): QueueSetAside {
  if (!error.aside) return new QueueSetAside(`${error.message} just now, so nothing was changed: try again.`);
  const aside = setAside(error.owner, now);
  return new QueueSetAside(aside
    ? `${error.message}, so nothing was changed. It's kept at ${aside} for you to look at; try again to carry on with an empty queue for ${error.owner}.`
    : `${error.message}, so nothing was changed, and it couldn't be moved aside: look at ${fileOf(error.owner)}.`);
}

/** A queue that isn't one (`readQueue`) set aside, and an empty one in its place: for what runs on
 * its own (a move, numbers coming), which mustn't stall on it. */
export function readQueueSettingAside(owner: string, now = Date.now()): Queue {
  try {
    return readQueue(owner);
  } catch (error) {
    if (!(error instanceof UnreadableQueue) || !error.aside || !setAside(owner, now)) throw error;
    return { owner, items: [] };
  }
}

/** An owner's queue for a view: one that can't be read shows as empty (and stays as it is). */
const readQueueOrNone = (owner: string): Queue => {
  try {
    return readQueue(owner);
  } catch (error) {
    if (error instanceof UnreadableQueue) return { owner, items: [] };
    throw error;
  }
};

/** The owners with a queue here. (A queue of a kind a newer box keeps, of an owner this box doesn't
 * know, isn't one: it's read only when a move carries it, `readKeptQueue`, and never changed here
 * otherwise.) */
export function owners(): string[] {
  return listOf(QUEUES).filter(name => name.endsWith(".json")).map(name => name.slice(0, -5)).filter(owner => OWNER.test(owner));
}

/** Every queue here. */
export const readAll = (): Queue[] => onceEach(owners().map(readQueueOrNone));

/** A queue of a kind a newer box keeps (`KEPT_OWNER`, not `OWNER`), as a move carries it: only when
 * every item in it reads as one here, else null (left as it is, and where it is). */
export function readKeptQueue(owner: string): Queue | null {
  if (!KEPT_OWNER.test(owner) || OWNER.test(owner)) return null;
  let kept: unknown;
  try {
    kept = JSON.parse(fs.readFileSync(fileOf(owner), "utf8"));
  } catch {
    return null;
  }
  if (!isObject(kept) || !Array.isArray(kept.items)) return null;
  const items = kept.items.map(each => itemOf(each, owner));
  return items.every(each => each !== null) ? { owner, items: items as Item[] } : null;
}

/** An item two queues hold (a hand-off or a move cut off between its two writes) kept once: in the
 * queue it went to last (the newer change), the queues changed in place. */
function onceEach(queues: Queue[]): Queue[] {
  const seen = new Map<string, { queue: Queue; item: Item }>();
  for (const queue of queues) {
    for (const item of [...queue.items]) {
      const other = seen.get(item.id);
      if (!other) { seen.set(item.id, { queue, item }); continue; }
      const loser = item.updated.at >= other.item.updated.at ? other.queue : queue;
      loser.items = loser.items.filter(each => each.id !== item.id);
      if (loser === other.queue) seen.set(item.id, { queue, item });
    }
  }
  return queues;
}

/** Every item here, of every owner (deleted ones too). */
export const allItems = (): Item[] => readAll().flatMap(queue => queue.items);

/** The queues here as one change sees them: each read once, written back if it changed. */
export class Book {
  private readonly queues = new Map<string, Queue>();
  private readonly before = new Map<string, string>();

  constructor() {
    for (const owner of owners()) this.load(owner);
    onceEach([...this.queues.values()]);
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

  /** An owner's queue (made when it has none). One of a kind a newer box keeps is read now, only
   * here (a move's), and only when it reads whole (`readKeptQueue`); one that doesn't is refused,
   * left as it is. */
  queue(owner: string): Queue {
    if (!OWNER.test(owner) && !this.queues.has(owner)) {
      const kept = fs.existsSync(fileOf(owner)) ? readKeptQueue(owner) : { owner, items: [] };
      if (!kept) throw new Refusal(`${owner}'s Work Queue was kept by a newer Kuvo Code, in a way this one can't read: it's left as it is.`);
      this.queues.set(owner, kept);
      this.before.set(owner, JSON.stringify(kept.items));
    }
    return this.load(owner);
  }

  /** Every item, of every owner (not those of a kind a newer box keeps, left as they are). */
  items(): Item[] {
    return [...this.queues.values()].filter(queue => OWNER.test(queue.owner)).flatMap(queue => queue.items);
  }

  /** The item with this id or number (the first, where two computers gave one number twice). */
  find(ref: { id?: string; number?: number }): Item | null {
    return this.findAll(ref)[0] ?? null;
  }

  /** Every item with this id or number. */
  findAll(ref: { id?: string; number?: number }): Item[] {
    return matching(this.items(), ref);
  }

  /** `item` moved into `owner`'s queue. */
  give(item: Item, owner: string): void {
    const from = this.load(item.owner);
    from.items = from.items.filter(each => each.id !== item.id);
    item.owner = owner;
    this.load(owner).items.push(item);
  }

  /** What changed, written: the queues that gained items first, so a write cut off between two
   * leaves an item in both (read once, see `items`) rather than in neither. */
  save(): boolean {
    let any = false;
    const changed = [...this.queues].filter(([owner, queue]) => JSON.stringify(queue.items) !== this.before.get(owner));
    const gained = (owner: string, queue: Queue) => {
      const had = new Set((JSON.parse(this.before.get(owner) ?? "[]") as Item[]).map(item => item.id));
      return queue.items.some(item => !had.has(item.id));
    };
    changed.sort(([a, queueA], [b, queueB]) => Number(gained(b, queueB)) - Number(gained(a, queueA)));
    for (const [owner, queue] of changed) {
      any = true;
      if (!queue.items.length) fs.rmSync(fileOf(owner), { force: true });
      else writePrivate(fileOf(owner), JSON.stringify({ owner, items: queue.items }));
      this.before.set(owner, JSON.stringify(queue.items));
    }
    return any;
  }
}

/** `work` done on the queues here, one process at a time; what it changed written, and those
 * following told. Deleted items past their 30 days go first (and their files). */
export function changeQueues<T>(work: (book: Book) => T, now = Date.now(), { onItsOwn = false }: { onItsOwn?: boolean } = {}): T {
  fs.mkdirSync(WORK_QUEUE, { recursive: true, mode: 0o700 });
  const { value, changed } = locked(LOCK, () => {
    let book: Book;
    try {
      book = new Book();
    } catch (error) {
      if (!(error instanceof UnreadableQueue)) throw error;
      const refused = refusedOver(error, now);
      // What runs on its own carries on, the bad file set aside (it said so in the box's log).
      if (!onItsOwn || !error.aside) throw refused;
      console.error(`Work Queue: ${refused.message}`);
      book = new Book();
    }
    const purged: string[] = [];
    for (const queue of owners().map(owner => book.queue(owner))) {
      const gone = queue.items.filter(item => item.removed && now - item.removed.at > KEPT_REMOVED);
      if (!gone.length) continue;
      queue.items = queue.items.filter(item => !gone.includes(item));
      purged.push(...gone.map(item => item.id));
    }
    const value = work(book);
    const changed = book.save();
    // (Their files only once the queues no longer list them: a refused change leaves both.)
    for (const id of purged) fs.rmSync(path.join(FILES, id), { recursive: true, force: true });
    return { value, changed };
  });
  if (changed) noteQueuesChanged();
  return value;
}

/** A change refused, in words for whoever asked (an agent's tool, a client's route). */
export class Refusal extends Error {}

/** A change refused because a queue file couldn't be read (it's set aside now). */
export class QueueSetAside extends Refusal {}

/** Those following told of a change (made here, or by another process: its files say so too). */
export function noteQueuesChanged(): void {
  for (const tell of queueFollowers) tell();
}

/** The items `ref` names, by id or number. */
export const matching = (items: Item[], ref: { id?: string; number?: number }): Item[] => items.filter(item => (ref.id ? item.id === ref.id : item.number === ref.number));

/** The folder an item's files are kept in. */
export const filesOf = (item: string) => path.join(FILES, item);

/** The place at the end of a category (or its start, `top`), among every owner's items here. */
export function placeIn(items: Item[], category: string, { top = false }: { top?: boolean } = {}): number {
  const orders = items.filter(item => item.category === category && !item.removed).map(item => item.order);
  if (!orders.length) return 0;
  return top ? Math.min(...orders) - 1 : Math.max(...orders) + 1;
}

/** The place just before (or after) `beside` in its category, for `moving`. Where two places are
 * too close to put one between, the category is numbered afresh first, in the order it has. */
export function placeBeside(items: Item[], beside: Item, after: boolean, moving?: Item): number {
  const others = () => items.filter(item => item.category === beside.category && !item.removed && item.id !== beside.id && item.id !== moving?.id).map(item => item.order).sort((a, b) => a - b);
  const neighbor = () => (after ? others().find(order => order > beside.order) : [...others()].reverse().find(order => order < beside.order));
  let next = neighbor();
  if (next !== undefined && Math.abs(next - beside.order) < 1e-6) {
    items.filter(item => item.category === beside.category && !item.removed).sort((a, b) => a.order - b.order).forEach((item, index) => { item.order = index; });
    next = neighbor();
  }
  return next === undefined ? beside.order + (after ? 1 : -1) : (beside.order + next) / 2;
}

/** A note of who handed an item to whom, the last few kept. */
export function noteHanded(item: Item, from: string, to: string, at: number): void {
  item.handedBy ??= from;
  item.handed = [...(item.handed ?? []), { from, to, at }].slice(-MOST_HANDED);
}

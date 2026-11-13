// What changes the Work Queue (PROTOCOL.md, "The Work Queue"): an item added, changed, handed on,
// deleted or brought back, moved by you, and files kept with it. The tools and the routes both come
// here, so an agent's change and yours follow the same rules.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { isObject } from "../../shared/json";
import { plainName } from "../../shared/text";
import { accountHome, APP_FOLDER, BOTS, homeFolder, K, OWN_HOME_MAC } from "../home";
import { categoryNamed } from "./categories";
import { takeNumber, type Primary } from "./numbers";
import {
  FILES, filesOf, matching, MOST_BODY, MOST_EVENTS, MOST_FILE, MOST_FILES, MOST_ITEMS, MOST_LINKS, MOST_NOTE, MOST_NOTES, MOST_TITLE, newItemID, noteHanded, placeBeside, placeIn, Refusal,
  type Book, type Item, type ItemEvent, type KeptFile, type Source, type Who,
} from "./store";
import { nameOf, refOf } from "./view";
import { doneOnGitHub, seenOf } from "./github";
import { frozen } from "../moves/records";

/** A session is linked to this many items at most: linking one more drops its oldest link. */
export const LINKS_EACH = 3;
const MOST_PROGRESS_NOTE = 300;

export { Refusal };
const refuse = (words: string): never => { throw new Refusal(words); };

// Where files an agent named wait, read, until the change that keeps them.
const STAGING = path.join(path.dirname(FILES), "staging");

/** What's left in the staging folder by a box that stopped midway: gone, once it's an hour old. */
export function clearStaging(now = Date.now()): void {
  for (const name of (() => { try { return fs.readdirSync(STAGING); } catch { return []; } })()) {
    try {
      if (now - fs.statSync(path.join(STAGING, name)).mtimeMs > 3_600_000) fs.rmSync(path.join(STAGING, name), { recursive: true, force: true });
    } catch {}
  }
}

// A file's name, short enough to keep with " 2" added and stay within a name's 255 bytes: its stem
// cut, its extension kept.
const shortName = (name: string): string => {
  const ext = path.extname(name).slice(0, 20);
  let stem = name.slice(0, name.length - path.extname(name).length);
  while (stem && Buffer.byteLength(stem + ext) > 180) stem = Array.from(stem).slice(0, -1).join("");
  return stem + ext;
};

/** Changes to the queues of owners that are moving to another computer wait until they're there:
 * what's changed meanwhile would be left behind. */
export function refuseMoving(owners: (string | undefined)[], moving: Set<string> = frozen()): void {
  for (const owner of owners) if (owner && moving.has(owner)) refuse(owner.startsWith("grp_") ? "This group chat is moving to another computer, with its Work Queue: try again once it's there." : "That conversation is moving to another computer, with its Work Queue: try again once it's there.");
}

/** Changes to an item on its way to another computer wait until it's there: it's that
 * conversation's then, and what's changed here meanwhile would be left behind. */
export function refuseHanding(item: Item): void {
  if (item.handing) refuse(`${nameOf(item)} is being handed to ${item.handing.name || item.handing.to} on another computer: change it there once it's arrived.`);
}

/** Where an agent's files may come from: its conversation's folder, its project's other folders,
 * and the temporary folders; never Kuvo Code's own (but for its own folder there, a bot's). */
export interface FilePlaces { own: string | null; others: readonly string[] }

const real = (place: string): string | null => {
  try { return fs.realpathSync(place); } catch { return null; }
};
const within = (file: string, folder: string) => file === folder || file.startsWith(folder.endsWith(path.sep) ? folder : folder + path.sep);

/** Whether `file` (where it really is) is in this Mac's app's folders, for a Mac's box in a home of its
 * own, whose home isn't in them: any copy's (`~/Library/<Application Support, Caches…>/run.kuvo.code…`),
 * as the sandbox keeps them (fence/policy.ts, `kuvoPatterns`). */
function inMacApp(file: string): boolean {
  if (!OWN_HOME_MAC || process.platform !== "darwin") return false;
  return [...new Set([homeFolder(), accountHome()].map(each => real(each) ?? each))]
    .some(home => /^run\.kuvo\.code/i.test(path.relative(path.join(home, "Library"), file).split(path.sep)[1] ?? "") && within(file, path.join(home, "Library")));
}

/** A file an agent named, read into `staging` (outside the queue's lock): checked where it really
 * is (links followed) to be a plain file of a size the queue keeps, in one of `places`, with no
 * hidden folder or file on the way; then opened without following a link or waiting on it, and
 * kept only if what was opened is that same file, with no other name (a hard link elsewhere). */
export function stageFile(given: string, places: FilePlaces, staging: string): Staged {
  if (!path.isAbsolute(given)) refuse(`Give ${given} as a full path.`);
  const file = real(given) ?? refuse(`There's no file at ${given}.`);
  const own = places.own ? real(places.own) : null;
  const roots = [own, ...places.others.map(real), real(os.tmpdir()), real("/tmp")].filter((each): each is string => Boolean(each));
  const root = roots.find(each => within(file, each));
  // Kuvo Code's own folders (on a Mac, the app's around its box's): never, unless the conversation's
  // own folder is itself in them (a bot's, a chat's), and then only what's in that folder. A project
  // that holds them (one at the home folder) doesn't make them its own.
  const boxes = [real(K), real(BOTS), APP_FOLDER ? real(APP_FOLDER) : null].filter((each): each is string => Boolean(each));
  const ownOK = own !== null && root === own && boxes.some(box => within(own, box));
  if (!root || (!ownOK && (boxes.some(box => within(file, box)) || inMacApp(file)))) refuse(`${given} isn't in this conversation's folder, its project or a temporary folder: only files from there are kept with an item.`);
  if (path.relative(root!, file).split(path.sep).some(part => part.startsWith("."))) refuse(`${given} is hidden (a name starting with a dot): it isn't kept with an item.`);
  const checked = fs.lstatSync(file);
  if (!checked.isFile()) refuse(`${given} isn't a file.`);
  if (checked.size > MOST_FILE) refuse(`${given} is over ${Math.round(MOST_FILE / 1_000_000)} MB: too big to keep with an item.`);
  let handle: number;
  try {
    handle = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  } catch {
    return refuse(`${given} can't be read.`);
  }
  try {
    const opened = fs.fstatSync(handle);
    // (And still where it was found: a folder on the way swapped for a link meanwhile is said.)
    if (!opened.isFile() || opened.dev !== checked.dev || opened.ino !== checked.ino || real(given) !== file) refuse(`${given} changed as it was read: try again.`);
    if (opened.nlink !== 1) refuse(`${given} has other names (a hard link): it isn't kept with an item.`);
    const size = Math.min(opened.size, MOST_FILE);
    const bytes = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const got = fs.readSync(handle, bytes, read, size - read, read);
      if (!got) break;
      read += got;
    }
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    const staged = path.join(staging, `${crypto.randomBytes(8).toString("hex")}`);
    fs.writeFileSync(staged, bytes.subarray(0, read), { mode: 0o600 });
    return { staged, name: path.basename(file), size: read };
  } finally {
    fs.closeSync(handle);
  }
}

/** A file read for an item, waiting in the staging folder until the change that keeps it. */
export interface Staged { staged: string; name: string; size: number }

/** The files an agent named, read before the queue's lock is taken: what was read, and a way to
 * clear what's left of it. */
export function stageFiles(given: unknown, places: FilePlaces | null): { staged: Staged[]; clear: () => void } {
  const named = given === undefined ? [] : (Array.isArray(given) ? given : [given]).map(each => (typeof each === "string" ? each.trim() : "")).filter(Boolean);
  if (named.length && !places) refuse("Only an agent's own files are kept with an item.");
  if (named.length > MOST_FILES) refuse(`An item keeps ${MOST_FILES} files at most.`);
  const staging = path.join(STAGING, crypto.randomBytes(8).toString("hex"));
  const clear = () => fs.rmSync(staging, { recursive: true, force: true });
  try {
    return { staged: named.map(each => stageFile(each, places!, staging)), clear };
  } catch (error) {
    clear();
    throw error;
  }
}

const TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".heic": "image/heic", ".svg": "image/svg+xml",
  ".pdf": "application/pdf", ".md": "text/markdown", ".txt": "text/plain", ".json": "application/json", ".csv": "text/csv", ".mp4": "video/mp4", ".mov": "video/quicktime",
};
export const typeOf = (name: string) => TYPES[path.extname(name).toLowerCase()] ?? "application/octet-stream";

const text = (value: unknown, most: number, what: string): string => {
  if (typeof value !== "string") return refuse(`${what} should be text.`);
  if (value.length > most) refuse(`${what} is over ${most.toLocaleString("en-US")} characters: make it shorter.`);
  return value;
};

const linksOf = (value: unknown): { url: string; title?: string }[] => {
  const given = Array.isArray(value) ? value : [value];
  return given.map(each => {
    const url = typeof each === "string" ? each : isObject(each) && typeof each.url === "string" ? each.url : "";
    if (!/^https?:\/\/\S+$/i.test(url.trim())) refuse(`${url || "A link"} isn't a web address (https://…).`);
    const title = isObject(each) && typeof each.title === "string" ? plainName(each.title).slice(0, 200) : "";
    return { url: url.trim().slice(0, 2000), ...(title ? { title } : {}) };
  });
};

/** A category an agent or you named for an item, or why not. */
export function categoryFor(given: unknown): string {
  if (typeof given === "string" && /^\s*in[ -]?progress\s*$/i.test(given)) refuse("In progress isn't a category you set: an item is in progress while a session linked to it is at work. Link one with working: true (or sessions).");
  const found = categoryNamed(given);
  if (!found) return refuse(`There's no category ${String(given ?? "")}: queue_categories lists them.`);
  return found.id;
}

/** `session` linked to `item`, its oldest other link dropped when it has `LINKS_EACH` already
 * (said there as its work stopped, where it had said it started). */
export function linkSession(book: Book, item: Item, session: string, now: number): void {
  if (item.sessions.some(each => each.session === session)) return;
  const others = book.items().filter(each => each.id !== item.id && each.sessions.some(link => link.session === session));
  if (others.length >= LINKS_EACH) {
    const oldest = others.sort((a, b) => a.sessions.find(link => link.session === session)!.since - b.sessions.find(link => link.session === session)!.since)[0];
    unlinkSessions(oldest, [session], now);
  }
  item.sessions.push({ session, since: now });
}

// Reorders within one category by the same one, each soon after the last, are one move in the feed.
const FOLD_REORDERS = 10 * 60_000;
// A session that stops and starts again this soon never stopped, as the feed says it.
const FOLD_RESTART = 2 * 60_000;

/** Who did something, the same one: you, or one agent. */
const sameWho = (a: Who, b: Who): boolean => JSON.stringify(a) === JSON.stringify(b);

/** What happened to `item` kept with it, its last `MOST_EVENTS`. A reorder right after the same
 * one's reorder in the same category is folded into it; a start right after the same one's stop
 * is no stop at all: each with nothing said between (no note, no hand-off), and never back in time
 * (a clock ahead on another computer). */
export function noteEvent(item: Item, event: ItemEvent): void {
  const events = [...(item.events ?? [])];
  const last = events.at(-1);
  const reorder = (each: ItemEvent) => each.kind === "moved" && each.from === each.to;
  const quiet = (since: number) => !item.notes.some(note => note.at >= since) && !(item.handed ?? []).some(each => each.at >= since);
  const within = (most: number) => last !== undefined && event.at >= last.at && event.at - last.at < most;
  if (last && reorder(last) && reorder(event) && last.to === event.to && sameWho(last.by, event.by) && within(FOLD_REORDERS) && quiet(last.at)) {
    const { top: _, ...folded } = last;
    events[events.length - 1] = { ...folded, at: event.at, ...(event.top ? { top: true as const } : {}) };
  } else if (last && last.kind === "stopped" && event.kind === "started" && sameWho(last.by, event.by) && within(FOLD_RESTART) && quiet(last.at)) {
    events.pop();
  } else {
    events.push(event);
  }
  item.events = events.slice(-MOST_EVENTS);
}

// The latest word of `session`'s work on `item`, that it started or stopped, since the item was
// last done (Done unlinked everyone, saying no `stopped`: a word from before it is over).
function lastWord(item: Item, session: string): ItemEvent | undefined {
  for (const each of [...(item.events ?? [])].reverse()) {
    if (each.kind === "done") return undefined;
    if ((each.kind === "started" || each.kind === "stopped") && (each.by as { session?: unknown }).session === session) return each;
  }
  return undefined;
}

/** `sessions` unlinked from `item`: each that had said it started is kept as having stopped (as
 * it said it started), when its agent said so or its link was dropped for it. Done and a delete
 * unlink everyone without this: they say it themselves. */
export function unlinkSessions(item: Item, sessions: Iterable<string>, now: number, who?: Who): void {
  for (const session of sessions) {
    if (!item.sessions.some(each => each.session === session)) continue;
    item.sessions = item.sessions.filter(each => each.session !== session);
    const word = lastWord(item, session);
    if (word?.kind === "started") noteEvent(item, { at: now, by: who ?? word.by, kind: "stopped" });
  }
}

/** `session` at work on `item`, as its agent said (`working: true`): linked to it, and kept as
 * having started, unless it's at it already (linked, its last word that it started). */
export function startWork(book: Book, item: Item, session: string, { who, now }: Pick<Acting, "who" | "now">): void {
  const linked = item.sessions.some(each => each.session === session);
  linkSession(book, item, session, now);
  if (!linked || lastWord(item, session)?.kind !== "started") noteEvent(item, { at: now, by: who, kind: "started" });
}

/** `session` no longer at work on `item`, as its agent said (`working: false`): unlinked, and kept
 * as having stopped, when its last word was that it started. */
export function stopWork(item: Item, session: string, { who, now }: Pick<Acting, "who" | "now">): void {
  unlinkSessions(item, [session], now, who);
}

/** Who moves an item the box itself moves (one whose category isn't kept here goes to Next). */
export const THE_BOX: Who = { source: "kuvo", name: "Kuvo Code" };

/** `item`, whose category `from` this box doesn't keep, in Next, said in its feed. */
export function intoNext(item: Item, from: string, now: number): void {
  item.category = "next";
  noteEvent(item, { at: now, by: THE_BOX, kind: "moved", from, to: "next" });
}

/** What an add or a change gives: the fields, as the tools name them. */
export interface Fields {
  title?: unknown;
  body?: unknown;
  category?: unknown;
  top?: unknown;
  before?: unknown;
  after?: unknown;
  progress?: unknown;
  progress_note?: unknown;
  note?: unknown;
  links?: unknown;
  files?: unknown;
  /** Links (by address) and files (by name) to take away: one list for both. */
  remove?: unknown;
}

/** Who acts, when, the files it read for the change (`stageFiles`), and what's to be done on disk
 * once the change is sure (`applyFileOps`). */
export interface Acting { who: Who; now: number; staged?: Staged[]; fileOps: (() => void)[] }

/** What a change does on disk, done once nothing more can refuse it. */
export function applyFileOps(acting: Acting): void {
  for (const op of acting.fileOps.splice(0)) op();
}

// (An issue or a pull request closed on GitHub is Done, whatever category it's kept in.)
const openIn = (book: Book, owner: string) => book.queue(owner).items.filter(item => !item.removed && item.category !== "done" && !(item.source && doneOnGitHub(seenOf(item.source)?.value?.state))).length;

/** A new item in `owner`'s queue: numbered now if there's a number to give, else once one comes;
 * an outside source's (`source`, an issue or a pull request) never. */
export function addItem(book: Book, owner: string, fields: Fields, acting: Acting, primary: Primary, source?: Source): Item {
  const title = plainName(text(fields.title ?? "", MOST_TITLE * 4, "The title")).slice(0, MOST_TITLE);
  if (!title) refuse("Say what it is (title), in a line.");
  if (openIn(book, owner) >= MOST_ITEMS) refuse(`Your queue has ${MOST_ITEMS} open items already: mark some done or remove them first.`);
  const category = fields.category === undefined ? "next" : categoryFor(fields.category);
  if (source && category === "done") refuseDone(source.ref);
  const { now, who } = acting;
  const item: Item = {
    id: newItemID(),
    owner,
    title,
    body: "",
    category,
    order: placeIn(book.items(), category, { top: fields.top === true }),
    notes: [],
    files: [],
    links: [],
    sessions: [],
    created: { at: now, by: who },
    updated: { at: now, by: who },
    ...(category === "done" ? { doneAt: now } : {}),
    ...(source ? { source } : {}),
  };
  book.queue(owner).items.push(item);
  // (Its details as a change makes them, so the same checks hold: where it's put isn't a move.)
  changeItem(book, item, { ...fields, title: undefined, category: undefined, top: undefined }, acting, { added: true });
  // (An outside source's item is named by its ref, never numbered.)
  if (item.source) return item;
  const number = takeNumber(primary);
  if (number !== null) item.number = number;
  return item;
}

// Done asked of an issue or a pull request: GitHub's to say.
const refuseDone = (name: string): never => refuse(`${name} is Done once it's closed on GitHub (or, a pull request, merged): close it there, or let the pull request that fixes it close it.`);

/** `item` changed as `fields` say. */
export function changeItem(book: Book, item: Item, fields: Fields, acting: Acting, { added = false }: { added?: boolean } = {}): void {
  const { who, now } = acting;
  // (Where it is among its category's items: a move that leaves it there isn't one.)
  const placeNow = () => ({ category: item.category, index: book.items().filter(each => each.id !== item.id && !each.removed && each.category === item.category && each.order < item.order).length });
  const was = placeNow();
  if (fields.title !== undefined) {
    const title = plainName(text(fields.title, MOST_TITLE * 4, "The title")).slice(0, MOST_TITLE);
    if (!title) refuse("A title can't be empty.");
    item.title = title;
  }
  if (fields.body !== undefined) item.body = text(fields.body, MOST_BODY, "The description (body)");
  if (fields.category !== undefined) {
    const category = categoryFor(fields.category);
    // (An issue's or a pull request's Done is GitHub's: never set, nor left, here.)
    if (item.source && category === "done") refuseDone(nameOf(item));
    if (item.source && doneOnGitHub(seenOf(item.source)?.value?.state)) refuse(`${nameOf(item)} is closed on GitHub, so it's Done: it's back in its place once it's reopened there.`);
    if (category !== item.category) {
      item.category = category;
      item.order = placeIn(book.items(), category, { top: fields.top === true });
      if (category === "done") {
        item.doneAt = now;
        item.sessions = [];
      } else {
        delete item.doneAt;
      }
    }
  }
  const beside = (given: unknown) => {
    const ref = refOf(given);
    const all = ref ? matching(book.items(), ref).filter(each => !each.removed && each.id !== item.id) : [];
    // (Where two computers gave one number twice, the one in this item's category.)
    const found = all.find(each => each.category === item.category) ?? all[0];
    if (!found) refuse(`There's no other item ${String(given)} to put it beside.`);
    if (found!.category !== item.category) refuse(`${nameOf(found!)} is in another category: move it there first (category).`);
    return found!;
  };
  if (fields.before !== undefined) item.order = placeBeside(book.items(), beside(fields.before), false, item);
  else if (fields.after !== undefined) item.order = placeBeside(book.items(), beside(fields.after), true, item);
  else if (fields.top === true && fields.category === undefined) item.order = placeIn(book.items().filter(each => each.id !== item.id), item.category, { top: true });
  const placed = placeNow();
  if (added) {
    // (An item just added isn't moved, wherever it's put.)
  } else if (placed.category !== was.category && placed.category === "done") noteEvent(item, { at: now, by: who, kind: "done" });
  else if (placed.category !== was.category || placed.index !== was.index) {
    const top = placed.index === 0 && (fields.top === true || fields.before !== undefined || fields.after !== undefined);
    noteEvent(item, { at: now, by: who, kind: "moved", from: was.category, to: placed.category, ...(top ? { top: true as const } : {}) });
  }
  if (fields.progress !== undefined) {
    if (fields.progress === null) {
      if (item.progress) delete item.progress.value;
    } else if (typeof fields.progress !== "number" || !(fields.progress >= 0 && fields.progress <= 1)) {
      refuse("progress is a number from 0 to 1 (3 of 8 is 0.375), or null to take it away.");
    } else {
      item.progress = { ...(item.progress ?? {}), value: fields.progress };
    }
  }
  if (fields.progress_note !== undefined) {
    const note = fields.progress_note === null ? "" : plainName(text(fields.progress_note, MOST_PROGRESS_NOTE * 2, "progress_note")).slice(0, MOST_PROGRESS_NOTE);
    item.progress = { ...(item.progress ?? {}) };
    if (note) item.progress.note = note;
    else delete item.progress.note;
  }
  if (item.progress && item.progress.value === undefined && item.progress.note === undefined) delete item.progress;
  if (fields.note !== undefined) {
    const note = text(fields.note, MOST_NOTE, "The note").trim();
    if (note) item.notes = [...item.notes, { at: now, by: who, text: note }].slice(-MOST_NOTES);
  }
  const listed = (value: unknown): string[] => (value === undefined ? [] : (Array.isArray(value) ? value : [value]).map(String));
  const removing = listed(fields.remove);
  if (removing.length) {
    const gone = new Set(removing);
    item.links = item.links.filter(link => !gone.has(link.url));
  }
  if (fields.links !== undefined) {
    for (const link of linksOf(fields.links)) if (!item.links.some(each => each.url === link.url)) item.links.push(link);
    if (item.links.length > MOST_LINKS) refuse(`An item keeps ${MOST_LINKS} links at most.`);
  }
  // Files: everything checked first; what's on disk changes only as the change is kept
  // (`applyFileOps`), those taken away before those added.
  const gone = new Set(removing);
  const staged = fields.files === undefined ? [] : acting.staged ?? refuse("Only an agent's own files are kept with an item.");
  const left = item.files.filter(file => !gone.has(file.name));
  if (left.length + staged.length > MOST_FILES) refuse(`An item keeps ${MOST_FILES} files at most: take some away first (remove).`);
  for (const file of item.files) if (gone.has(file.name)) acting.fileOps.push(() => fs.rmSync(path.join(filesOf(item.id), file.name), { force: true }));
  item.files = left;
  for (const each of staged) {
    const base = shortName(each.name.replace(/[\\\0]/g, "_").replace(/^\.+/, "")) || "file";
    const ext = path.extname(base);
    let name = base;
    for (let n = 2; item.files.some(file => file.name === name); n++) name = `${base.slice(0, base.length - ext.length)} ${n}${ext}`;
    item.files.push({ name, size: each.size, type: typeOf(name), at: now });
    acting.fileOps.push(() => {
      fs.mkdirSync(filesOf(item.id), { recursive: true, mode: 0o700 });
      fs.renameSync(each.staged, path.join(filesOf(item.id), name));
    });
  }
  item.updated = { at: now, by: who };
}

/** `item` made the outside source's item `source` is (an issue or a pull request): named by it from
 * now on (its number kept, never shown again, so it still finds it), with its title and
 * description; what the item said before is kept as a note. */
export function linkSource(item: Item, source: Source, title: string, body: string, { who, now }: Acting): void {
  if (item.source) refuse(`${nameOf(item)} is ${item.source.ref} already: one item is one issue or pull request.`);
  if (item.category === "done") refuse(`${nameOf(item)} is Done: move it out of Done first (category), or add the issue as an item of its own (queue_add with issue).`);
  const before = item.body.trim();
  item.source = source;
  item.title = plainName(title).slice(0, MOST_TITLE) || item.title;
  if (body.trim()) {
    item.body = body.slice(0, MOST_BODY);
    if (before) item.notes = [...item.notes, { at: now, by: who, text: `What it said before it was ${source.ref}:\n\n${before}`.slice(0, MOST_NOTE) }].slice(-MOST_NOTES);
  }
  item.updated = { at: now, by: who };
}

/** `item` deleted: kept 30 days for an undo, no session linked any more. */
export function removeItem(item: Item, who: Who, now: number): void {
  item.removed = { at: now, by: who };
  item.sessions = [];
  item.updated = { at: now, by: who };
}

/** `item` brought back, at the end of its category (Next, for one whose category is gone). */
export function restoreItem(book: Book, item: Item, who: Who, now: number): void {
  delete item.removed;
  if (!categoryNamed(item.category)) intoNext(item, item.category, now);
  item.order = placeIn(book.items(), item.category);
  item.updated = { at: now, by: who };
}

/** `item` handed to the conversation `to`: into its queue, linked to it. */
export function handItem(book: Book, item: Item, to: string, who: Who, now: number): void {
  const from = item.owner;
  if (from === to) refuse(`${nameOf(item)} is in that queue already.`);
  if (openIn(book, to) >= MOST_ITEMS) refuse(`That queue has ${MOST_ITEMS} open items already.`);
  book.give(item, to);
  noteHanded(item, from, to, now);
  if (to.startsWith("ses_") && item.category !== "done") linkSession(book, item, to, now);
  item.updated = { at: now, by: who };
}

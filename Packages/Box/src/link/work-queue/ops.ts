// What changes the Work Queue (PROTOCOL.md, "The Work Queue"): an item added, changed, handed on,
// deleted or brought back, moved by you, and files kept with it. The tools and the routes both come
// here, so an agent's change and yours follow the same rules.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isObject } from "../../shared/json";
import { plainName } from "../../shared/text";
import { BOTS, K } from "../home";
import { categoryNamed } from "./categories";
import { takeNumber, type Primary } from "./numbers";
import {
  filesOf, MOST_BODY, MOST_FILE, MOST_FILES, MOST_ITEMS, MOST_LINKS, MOST_NOTE, MOST_NOTES, MOST_TITLE, newItemID, noteHanded, placeBeside, placeIn,
  type Book, type Item, type KeptFile, type Who,
} from "./store";
import { nameOf } from "./view";

/** A session is linked to this many items at most: linking one more drops its oldest link. */
export const LINKS_EACH = 3;
const MOST_PROGRESS_NOTE = 300;

export class Refusal extends Error {}
const refuse = (words: string): never => { throw new Refusal(words); };

/** Where an agent's files may come from: its conversation's folder, its project's other folders,
 * and the temporary folders; never Kuvo Code's own (but for its own folder there, a bot's). */
export interface FilePlaces { own: string | null; others: readonly string[] }

const real = (place: string): string | null => {
  try { return fs.realpathSync(place); } catch { return null; }
};
const within = (file: string, folder: string) => file === folder || file.startsWith(folder.endsWith(path.sep) ? folder : folder + path.sep);

/** A file an agent named, checked: where it really is (links followed), and that it's a plain file
 * of a size the queue keeps, in one of `places`, with no hidden folder or file on the way. */
export function attachable(given: string, places: FilePlaces): { file: string; size: number } {
  if (!path.isAbsolute(given)) refuse(`Give ${given} as a full path.`);
  const file = real(given) ?? refuse(`There's no file at ${given}.`);
  const own = places.own ? real(places.own) : null;
  const roots = [own, ...places.others.map(real), real(os.tmpdir()), real("/tmp")].filter((each): each is string => Boolean(each));
  const root = roots.find(each => within(file, each));
  const boxes = [real(K), real(BOTS)].filter((each): each is string => Boolean(each));
  const ownOK = own !== null && root === own;
  if (!root || (!ownOK && boxes.some(box => within(file, box)))) refuse(`${given} isn't in this conversation's folder, its project or a temporary folder: only files from there are kept with an item.`);
  if (path.relative(root!, file).split(path.sep).some(part => part.startsWith("."))) refuse(`${given} is hidden (a name starting with a dot): it isn't kept with an item.`);
  const kind = fs.lstatSync(file);
  if (!kind.isFile()) refuse(`${given} isn't a file.`);
  if (kind.size > MOST_FILE) refuse(`${given} is over ${Math.round(MOST_FILE / 1_000_000)} MB: too big to keep with an item.`);
  return { file, size: kind.size };
}

const TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".heic": "image/heic", ".svg": "image/svg+xml",
  ".pdf": "application/pdf", ".md": "text/markdown", ".txt": "text/plain", ".json": "application/json", ".csv": "text/csv", ".mp4": "video/mp4", ".mov": "video/quicktime",
};
export const typeOf = (name: string) => TYPES[path.extname(name).toLowerCase()] ?? "application/octet-stream";
export const FILE_NAME = /^[^/\\\0]{1,200}$/;

// `file` copied into the item's folder under a name of its own there (read without following a link).
function keepFile(item: Item, file: string, size: number, now: number): KeptFile {
  if (item.files.length >= MOST_FILES) refuse(`${nameOf(item)} has ${MOST_FILES} files already: remove some first.`);
  const base = path.basename(file).replace(/[\\\0]/g, "_").slice(-200) || "file";
  let name = base;
  const ext = path.extname(base);
  for (let n = 2; item.files.some(each => each.name === name); n++) name = `${base.slice(0, base.length - ext.length)} ${n}${ext}`;
  const folder = filesOf(item.id);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const handle = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    fs.writeFileSync(path.join(folder, name), fs.readFileSync(handle), { mode: 0o600 });
  } finally {
    fs.closeSync(handle);
  }
  return { name, size, type: typeOf(name), at: now };
}

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

/** `session` linked to `item`, its oldest other link dropped when it has `LINKS_EACH` already. */
export function linkSession(book: Book, item: Item, session: string, now: number): void {
  if (item.sessions.some(each => each.session === session)) return;
  const others = book.items().filter(each => each.id !== item.id && each.sessions.some(link => link.session === session));
  if (others.length >= LINKS_EACH) {
    const oldest = others.sort((a, b) => a.sessions.find(link => link.session === session)!.since - b.sessions.find(link => link.session === session)!.since)[0];
    oldest.sessions = oldest.sessions.filter(link => link.session !== session);
  }
  item.sessions.push({ session, since: now });
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
  remove_links?: unknown;
  files?: unknown;
  remove_files?: unknown;
}

/** Who acts, and from where: the session to link with `working`, and where its files may come from. */
export interface Acting { who: Who; files: FilePlaces | null; now: number }

const openIn = (book: Book, owner: string) => book.queue(owner).items.filter(item => !item.removed && item.category !== "done").length;

/** A new item in `owner`'s queue: numbered now if there's a number to give, else once one comes. */
export function addItem(book: Book, owner: string, fields: Fields, acting: Acting, primary: Primary): Item {
  const title = plainName(text(fields.title ?? "", MOST_TITLE * 4, "The title")).slice(0, MOST_TITLE);
  if (!title) refuse("Say what it is (title), in a line.");
  if (openIn(book, owner) >= MOST_ITEMS) refuse(`Your queue has ${MOST_ITEMS} open items already: mark some done or remove them first.`);
  const category = fields.category === undefined ? "next" : categoryFor(fields.category);
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
  };
  book.queue(owner).items.push(item);
  // (Its details as a change makes them, so the same checks hold.)
  changeItem(book, item, { ...fields, title: undefined, category: undefined, top: undefined }, acting);
  const number = takeNumber(primary);
  if (number !== null) item.number = number;
  return item;
}

/** `item` changed as `fields` say. */
export function changeItem(book: Book, item: Item, fields: Fields, { who, files, now }: Acting): void {
  if (fields.title !== undefined) {
    const title = plainName(text(fields.title, MOST_TITLE * 4, "The title")).slice(0, MOST_TITLE);
    if (!title) refuse("A title can't be empty.");
    item.title = title;
  }
  if (fields.body !== undefined) item.body = text(fields.body, MOST_BODY, "The description (body)");
  if (fields.category !== undefined) {
    const category = categoryFor(fields.category);
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
    const found = book.items().find(each => !each.removed && (each.id === given || (typeof given === "string" || typeof given === "number") && String(each.number) === String(given).replace(/^#/, "")));
    if (!found) refuse(`There's no item ${String(given)} to put it beside.`);
    if (found!.category !== item.category) refuse(`${nameOf(found!)} is in another category: move it there first (category).`);
    return found!;
  };
  if (fields.before !== undefined) item.order = placeBeside(book.items(), beside(fields.before), false);
  else if (fields.after !== undefined) item.order = placeBeside(book.items(), beside(fields.after), true);
  else if (fields.top === true && fields.category === undefined) item.order = placeIn(book.items().filter(each => each.id !== item.id), item.category, { top: true });
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
  if (fields.remove_links !== undefined) {
    const gone = new Set((Array.isArray(fields.remove_links) ? fields.remove_links : [fields.remove_links]).map(String));
    item.links = item.links.filter(link => !gone.has(link.url));
  }
  if (fields.links !== undefined) {
    for (const link of linksOf(fields.links)) if (!item.links.some(each => each.url === link.url)) item.links.push(link);
    if (item.links.length > MOST_LINKS) refuse(`An item keeps ${MOST_LINKS} links at most.`);
  }
  if (fields.remove_files !== undefined) {
    const gone = new Set((Array.isArray(fields.remove_files) ? fields.remove_files : [fields.remove_files]).map(String));
    for (const name of gone) if (item.files.some(file => file.name === name)) fs.rmSync(path.join(filesOf(item.id), name), { force: true });
    item.files = item.files.filter(file => !gone.has(file.name));
  }
  if (fields.files !== undefined) {
    const given = (Array.isArray(fields.files) ? fields.files : [fields.files]).map(each => (typeof each === "string" ? each.trim() : "")).filter(Boolean);
    if (given.length && !files) refuse("Only an agent's own files are kept with an item.");
    // (All checked before any is kept.)
    const checked = given.map(each => attachable(each, files!));
    for (const { file, size } of checked) item.files.push(keepFile(item, file, size, now));
  }
  item.updated = { at: now, by: who };
}

/** `item` deleted: kept 30 days for an undo, no session linked any more. */
export function removeItem(item: Item, who: Who, now: number): void {
  item.removed = { at: now, by: who };
  item.sessions = [];
  item.updated = { at: now, by: who };
}

/** `item` brought back, at the end of its category. */
export function restoreItem(book: Book, item: Item, who: Who, now: number): void {
  delete item.removed;
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

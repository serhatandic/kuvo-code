// What your other computers told this one of their Work Queues (PROTOCOL.md, "The Work Queue",
// "Across your computers"): each one's items as summaries, the owners they name, their custom
// categories, and how each numbers (when it was set up, and its primary). Kept in
// `run/work-queue/peers/<key>.json`, the newest from each, so the All view and a lead's view have
// them, as of when they were told, while that computer sleeps.

import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { cut, plainName } from "../../shared/text";
import { listOf, locked, writePrivate } from "../files";
import { KEY } from "../peers/known";
import { ITEM_ID, OWNER, WORK_QUEUE, whoOf as keptWho, type Who } from "./store";
import type { ItemSummary, OwnerFacts } from "./view";

export const TOLD = path.join(WORK_QUEUE, "peers");

/** How a computer numbers: its kind, when it was set up, the highest number it used or holds, the
 * primary it numbers from (`self` for itself), and whether it's a machine Macs share that aren't in
 * one setup (PROTOCOL.md, "Your setup": then none of them leads one; an older box says neither). */
export interface Numbering {
  kind: "mac" | "machine";
  since?: number;
  top?: number;
  primary?: { key: string; kind: "mac" | "machine"; since?: number };
  shared?: boolean;
}

/** An item as another computer tells it: its summary, and who handed it on. */
export type ToldItem = ItemSummary & { handedFrom?: string[] };

/** What a computer last told: as of when (its clock, `at`), when it was heard (this one's), its
 * items, the owners they name, its custom categories, and how it numbers. */
export interface Told extends Numbering {
  id: string;
  at: number;
  heard: number;
  items: ToldItem[];
  owners: OwnerFacts[];
  categories: { id: string; name: string }[];
}

/** How many items a computer tells at most, and of its Done ones. */
export const MOST_TOLD = 1500;
export const MOST_TOLD_DONE = 100;

const fileOf = (key: string) => path.join(TOLD, `${key}.json`);
const SESSION = /^ses_[A-Za-z0-9]{1,60}$/;
const CATEGORY = /^(?:next|later|parked|done|cat_[a-z0-9-]{1,40})$/;
const KIND = (value: unknown): "mac" | "machine" | null => (value === "mac" || value === "machine" ? value : null);
const count = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0);
const time = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);
const whole = (value: unknown, most = 999_999) => (typeof value === "number" && Number.isInteger(value) && value > 0 && value <= most ? value : undefined);
const words = (value: unknown, most: number) => (typeof value === "string" ? cut(plainName(value), most) : "");
// (As the box keeps one: an unknown shape as it came, and none at all as someone else, never you.)
const whoOf = (value: unknown): Who => keptWho(value) ?? { name: "someone else" };
const stamp = (value: unknown) => (isObject(value) ? { at: time(value.at), by: whoOf(value.by) } : { at: 0, by: whoOf(null) });

/** An item as it came from another computer, cleaned: what a summary has, nothing more; null for
 * one that isn't. */
export function toldItemOf(given: unknown, latest = Infinity): ToldItem | null {
  if (!isObject(given) || typeof given.id !== "string" || !ITEM_ID.test(given.id) || typeof given.owner !== "string" || !OWNER.test(given.owner)) return null;
  const title = words(given.title, 200);
  const category = typeof given.category === "string" && CATEGORY.test(given.category) ? given.category : "next";
  const progress = isObject(given.progress)
    ? { ...(typeof given.progress.value === "number" && given.progress.value >= 0 && given.progress.value <= 1 ? { value: given.progress.value } : {}), ...(typeof given.progress.note === "string" ? { note: words(given.progress.note, 300) } : {}) }
    : undefined;
  const sessions = (Array.isArray(given.sessions) ? given.sessions : []).filter(each => isObject(each) && typeof each.session === "string" && SESSION.test(each.session)).slice(0, 20)
    .map(each => ({ session: each.session as string, title: words(each.title, 200) || "New Session", working: each.working === true }));
  const lastNote = isObject(given.lastNote) && typeof given.lastNote.text === "string" ? { at: time(given.lastNote.at), by: whoOf(given.lastNote.by), text: cut(given.lastNote.text, 500) } : undefined;
  const source = isObject(given.source) && typeof given.source.kind === "string" && typeof given.source.ref === "string"
    ? Object.fromEntries(Object.entries(given.source).filter(([key, value]) => ["kind", "ref", "url", "host", "id", "name"].includes(key) && typeof value === "string").map(([key, value]) => [key, (value as string).slice(0, 2000)])) as unknown as ItemSummary["source"]
    : undefined;
  // (A GitHub issue's page only on GitHub: a client opens it.)
  if (source?.url && /^github/.test(source.kind) && !/^https:\/\/github\.com\//.test(source.url)) delete source.url;
  // (What GitHub said of it there, and when; with the category it keeps while that makes it Done.)
  const seen = source && isObject(given.seen) && typeof given.seen.state === "string" && /^[a-z_]{1,20}$/.test(given.seen.state)
    // (Never later than when it was told, nor than now: a clock set ahead there wins no read here.)
    ? { state: given.seen.state, at: Math.min(time(given.seen.at), latest), ...(typeof given.seen.checked === "number" ? { checked: Math.min(time(given.seen.checked), latest) } : {}), ...(given.seen.gone === true ? { gone: true } : {}) } : undefined;
  const keptIn = seen && typeof given.keptIn === "string" && CATEGORY.test(given.keptIn) ? given.keptIn : undefined;
  return {
    id: given.id,
    ...(whole(given.number) ? { number: whole(given.number) } : {}),
    ...(whole(given.wanted) ? { wanted: whole(given.wanted) } : {}),
    owner: given.owner,
    title: title || "Untitled",
    category,
    order: typeof given.order === "number" && Number.isFinite(given.order) ? given.order : 0,
    inProgress: given.inProgress === true,
    ...(progress && Object.keys(progress).length ? { progress } : {}),
    sessions,
    noteCount: count(given.noteCount),
    ...(lastNote ? { lastNote } : {}),
    fileCount: count(given.fileCount),
    linkCount: count(given.linkCount),
    ...(typeof given.handedBy === "string" && OWNER.test(given.handedBy) ? { handedBy: given.handedBy } : {}),
    ...(Array.isArray(given.handedFrom) ? { handedFrom: given.handedFrom.filter((each): each is string => typeof each === "string" && OWNER.test(each)).slice(0, 20) } : {}),
    ...(source ? { source } : {}),
    ...(seen ? { seen } : {}),
    ...(keptIn ? { keptIn } : {}),
    ...(isObject(given.handing) && typeof given.handing.to === "string" && OWNER.test(given.handing.to) ? { handing: { to: given.handing.to, name: words(given.handing.name, 100) } } : {}),
    created: stamp(given.created),
    updated: stamp(given.updated),
    ...(typeof given.doneAt === "number" ? { doneAt: time(given.doneAt) } : {}),
  };
}

const ownerOf = (given: unknown): OwnerFacts | null => {
  if (!isObject(given) || typeof given.owner !== "string" || !OWNER.test(given.owner)) return null;
  const kind = given.kind === "bot" || given.kind === "group" ? given.kind : "session";
  const bot = isObject(given.bot) && typeof given.bot.id === "string" && /^bot_[A-Za-z0-9]{1,60}$/.test(given.bot.id) ? { id: given.bot.id, name: words(given.bot.name, 100) } : undefined;
  return { owner: given.owner, kind, title: typeof given.title === "string" ? words(given.title, 200) : null, ...(bot ? { bot } : {}), ...(typeof given.startedBy === "string" && SESSION.test(given.startedBy) ? { startedBy: given.startedBy } : {}) };
};

/** How a computer said it numbers, cleaned. */
export function numberingOf(given: Record<string, unknown>): Numbering {
  const kind = KIND(given.kind) ?? "machine";
  const primary = isObject(given.primary) && typeof given.primary.key === "string" && KEY.test(given.primary.key) && KIND(given.primary.kind)
    ? { key: given.primary.key, kind: KIND(given.primary.kind)!, ...(time(given.primary.since) ? { since: time(given.primary.since) } : {}) } : undefined;
  return { kind, ...(time(given.since) ? { since: time(given.since) } : {}), ...(whole(given.top) ? { top: whole(given.top) } : {}), ...(primary ? { primary } : {}), ...(typeof given.shared === "boolean" ? { shared: given.shared } : {}) };
}

/** What a computer told, as it came, cleaned: null for what isn't. */
export function toldOf(given: unknown, now = Date.now()): Omit<Told, "heard"> | null {
  if (!isObject(given) || typeof given.id !== "string" || !/^wqt_[A-Za-z0-9_-]{8,40}$/.test(given.id) || typeof given.at !== "number" || !Array.isArray(given.items)) return null;
  const seen = new Set<string>();
  const latest = Math.min(given.at, now);
  const items = given.items.slice(0, MOST_TOLD).map(each => toldItemOf(each, latest)).filter((each): each is ToldItem => each !== null && !seen.has(each.id) && seen.add(each.id) !== undefined);
  const owners = (Array.isArray(given.owners) ? given.owners : []).slice(0, MOST_TOLD).map(ownerOf).filter((each): each is OwnerFacts => each !== null);
  const categories = (Array.isArray(given.categories) ? given.categories : []).filter(each => isObject(each) && typeof each.id === "string" && /^cat_[a-z0-9-]{1,40}$/.test(each.id) && typeof each.name === "string")
    .slice(0, 30).map(each => ({ id: each.id as string, name: words(each.name, 40) || (each.id as string).slice(4) }));
  return { id: given.id, at: Math.min(given.at, now), items, owners, categories, ...numberingOf(given) };
}

/** What the computer `key` last told, or null. */
export function readTold(key: string): Told | null {
  if (!KEY.test(key)) return null;
  try {
    const kept = JSON.parse(fs.readFileSync(fileOf(key), "utf8"));
    if (!isObject(kept) || typeof kept.at !== "number" || !Array.isArray(kept.items)) return null;
    return kept as unknown as Told;
  } catch {
    return null;
  }
}

// (One process at a time changes what's kept: the link takes what's told, a route patches it.)
const LOCK = path.join(WORK_QUEUE, ".told.lock");

/** `told` kept as what `key` said, unless what's kept is newer: whether it was. */
export function keepTold(key: string, told: Omit<Told, "heard">, now = Date.now()): boolean {
  if (!KEY.test(key)) return false;
  fs.mkdirSync(TOLD, { recursive: true, mode: 0o700 });
  return locked(LOCK, () => {
    const kept = readTold(key);
    // Older than what's kept: mail come late, unless it's a good while older (its clock was set
    // back), when it's the newer word after all.
    if (kept && kept.at > told.at && kept.at - told.at < 600_000 && kept.id !== told.id) return false;
    writePrivate(fileOf(key), JSON.stringify({ ...told, heard: now } satisfies Told));
    return true;
  });
}

/** A change you made to item `id` on the computer `key`, through this box, put in what that computer
 * last told, as its box answered it (`item`; `deleted`: taken out), until it tells again: what it
 * says of its sessions stays as it told it. Not over newer word of that item (told since). */
export function patchTold(key: string, id: string, item: unknown, deleted: boolean): void {
  if (!KEY.test(key)) return;
  const fresh = toldItemOf(item);
  // (An answer this box can't read changes nothing.)
  if (!fresh || fresh.id !== id) return;
  const removed = isObject(item) && isObject(item.removed) && typeof item.removed.at === "number" ? item.removed.at : 0;
  const answered = Math.max(fresh.updated.at, removed);
  try {
    locked(LOCK, () => {
      const kept = readTold(key);
      if (!kept) return;
      const before = kept.items.find(each => each.id === id);
      if (before && before.updated.at > answered) return;
      const others = kept.items.filter(each => each.id !== id);
      const items = deleted ? others
        : [...others, before ? { ...before, ...fresh, sessions: before.sessions, inProgress: before.inProgress, ...(before.progress ? { progress: before.progress } : {}), ...(before.handedFrom ? { handedFrom: before.handedFrom } : {}) } : fresh];
      writePrivate(fileOf(key), JSON.stringify({ ...kept, items }));
    });
  } catch {}
}

// What each computer last said of being shared, by the told file's time and size: read once a
// second for each one by `kuvo/setup/events`, so the whole of what it told is read only as it changes.
const sharedSaid = new Map<string, { stamp: string; shared: boolean | undefined }>();
/** Whether the computer `key` says it's a machine Macs share (`shared`), as it last told this one:
 * undefined for one that tells but doesn't say (an older box), null for one that never told. */
export function toldShared(key: string): boolean | undefined | null {
  if (!KEY.test(key)) return null;
  let stamp: string;
  try {
    const stat = fs.statSync(fileOf(key));
    stamp = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    sharedSaid.delete(key);
    return null;
  }
  const kept = sharedSaid.get(key);
  if (kept?.stamp === stamp) return kept.shared;
  const told = readTold(key);
  if (!told) return null;
  sharedSaid.set(key, { stamp, shared: told.shared });
  return told.shared;
}

/** The computers that told this one, by key. */
export const toldKeys = (): string[] => listOf(TOLD).filter(name => name.endsWith(".json")).map(name => name.slice(0, -5)).filter(key => KEY.test(key));

/** What a computer told, gone (one you removed). */
export const forgetTold = (key: string): void => {
  if (KEY.test(key)) fs.rmSync(fileOf(key), { force: true });
};

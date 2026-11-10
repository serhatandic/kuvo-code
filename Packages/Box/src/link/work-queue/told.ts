// What your other computers told this one of their Work Queues (PROTOCOL.md, "The Work Queue",
// "Across your computers"): each one's items as summaries, the owners they name, their custom
// categories, and how each numbers (when it was set up, and its primary). Kept in
// `run/work-queue/peers/<key>.json`, the newest from each, so the All view and a lead's view have
// them, as of when they were told, while that computer sleeps.

import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { cut, plainName } from "../../shared/text";
import { listOf, writePrivate } from "../files";
import { KEY } from "../peers/known";
import { ITEM_ID, OWNER, WORK_QUEUE, whoOf as keptWho, type Who } from "./store";
import type { ItemSummary, OwnerFacts } from "./view";

export const TOLD = path.join(WORK_QUEUE, "peers");

/** How a computer numbers: its kind, when it was set up, the highest number it used or holds, and
 * the primary it numbers from (`self` for itself). */
export interface Numbering {
  kind: "mac" | "machine";
  since?: number;
  top?: number;
  primary?: { key: string; kind: "mac" | "machine"; since?: number };
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
export function toldItemOf(given: unknown): ToldItem | null {
  if (!isObject(given) || typeof given.id !== "string" || !ITEM_ID.test(given.id) || typeof given.owner !== "string" || !OWNER.test(given.owner)) return null;
  const title = words(given.title, 200);
  const category = typeof given.category === "string" && /^(?:next|later|parked|done|cat_[a-z0-9-]{1,40})$/.test(given.category) ? given.category : "next";
  const progress = isObject(given.progress)
    ? { ...(typeof given.progress.value === "number" && given.progress.value >= 0 && given.progress.value <= 1 ? { value: given.progress.value } : {}), ...(typeof given.progress.note === "string" ? { note: words(given.progress.note, 300) } : {}) }
    : undefined;
  const sessions = (Array.isArray(given.sessions) ? given.sessions : []).filter(each => isObject(each) && typeof each.session === "string" && SESSION.test(each.session)).slice(0, 20)
    .map(each => ({ session: each.session as string, title: words(each.title, 200) || "New Session", working: each.working === true }));
  const lastNote = isObject(given.lastNote) && typeof given.lastNote.text === "string" ? { at: time(given.lastNote.at), by: whoOf(given.lastNote.by), text: cut(given.lastNote.text, 500) } : undefined;
  const source = isObject(given.source) && typeof given.source.kind === "string" && typeof given.source.ref === "string"
    ? Object.fromEntries(Object.entries(given.source).filter(([key, value]) => ["kind", "ref", "url", "host", "id"].includes(key) && typeof value === "string").map(([key, value]) => [key, (value as string).slice(0, 2000)])) as unknown as ItemSummary["source"]
    : undefined;
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
  return { kind, ...(time(given.since) ? { since: time(given.since) } : {}), ...(whole(given.top) ? { top: whole(given.top) } : {}), ...(primary ? { primary } : {}) };
}

/** What a computer told, as it came, cleaned: null for what isn't. */
export function toldOf(given: unknown, now = Date.now()): Omit<Told, "heard"> | null {
  if (!isObject(given) || typeof given.id !== "string" || !/^wqt_[A-Za-z0-9_-]{8,40}$/.test(given.id) || typeof given.at !== "number" || !Array.isArray(given.items)) return null;
  const seen = new Set<string>();
  const items = given.items.slice(0, MOST_TOLD).map(toldItemOf).filter((each): each is ToldItem => each !== null && !seen.has(each.id) && seen.add(each.id) !== undefined);
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

/** `told` kept as what `key` said, unless what's kept is newer: whether it was. */
export function keepTold(key: string, told: Omit<Told, "heard">, now = Date.now()): boolean {
  if (!KEY.test(key)) return false;
  const kept = readTold(key);
  // Older than what's kept: mail come late, unless it's a good while older (its clock was set back),
  // when it's the newer word after all.
  if (kept && kept.at > told.at && kept.at - told.at < 600_000 && kept.id !== told.id) return false;
  fs.mkdirSync(TOLD, { recursive: true, mode: 0o700 });
  writePrivate(fileOf(key), JSON.stringify({ ...told, heard: now } satisfies Told));
  return true;
}

/** The computers that told this one, by key. */
export const toldKeys = (): string[] => listOf(TOLD).filter(name => name.endsWith(".json")).map(name => name.slice(0, -5)).filter(key => KEY.test(key));

/** What a computer told, gone (one you removed). */
export const forgetTold = (key: string): void => {
  if (KEY.test(key)) fs.rmSync(fileOf(key), { force: true });
};

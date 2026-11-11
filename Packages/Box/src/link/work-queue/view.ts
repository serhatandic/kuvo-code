// What the Work Queue looks like to an owner (PROTOCOL.md, "The Work Queue"): its own items, those
// of the sessions it oversees (started by it, or by those), and those it handed on, each living
// once, in its owner's queue; with which of their sessions are at work now, which is what puts an
// item In progress. The box states these facts; clients group and draw them.

import { placeOfSession } from "../letters/letter";
import { listBots } from "../bots/list";
import { atWorkNow } from "../work/background";
import { startedByOf, under, workSessions, worksFor } from "../work/tree";
import type { Listed } from "../work/tree";
import type { Target } from "../../shared/records";
import type { Item, ItemRef, KeptFile, Link, Note, Source, Who } from "./store";
import { ITEM_ID } from "./store";
import { issueAt, sourceKey } from "./sources";
import { seenOf, withSeen, type Seen } from "./github";

/** What the box knows of the sessions here, for a view: every one an agent started (put away
 * ones too, so a lead still sees their items), and those at work now. */
export interface Facts {
  all: Listed[];
  working: Set<string>;
}

export async function factsOf(targets: Target[], signal?: AbortSignal): Promise<Facts> {
  const [all, working] = await Promise.all([workSessions(targets, signal, { archived: true }).catch(() => [] as Listed[]), atWorkNow(targets, signal).catch(() => new Set<string>())]);
  return { all, working };
}

/** The sessions `owner` oversees: those it started, theirs, and so on. */
export const overseenBy = (owner: string, all: Listed[]): Set<string> => new Set(owner.startsWith("ses_") ? under(owner, all).map(each => each.data.id) : []);

/** Whether `item` is in `owner`'s view: its own, a session's it oversees, or one it handed on. */
export const inView = (owner: string, item: Item, overseen: Set<string>): boolean =>
  item.owner === owner || overseen.has(item.owner) || item.handedBy === owner || Boolean(item.handed?.some(each => each.from === owner));

/** Whether the item is in progress: not done or deleted, and a session linked to it at work. */
export const inProgress = (item: Item, working: Set<string>): boolean =>
  !item.removed && item.category !== "done" && item.sessions.some(each => working.has(each.session));

/** An item named in a tool's words or a route: `#243`, `243`, its id, or the GitHub issue or pull
 * request it is (`gh:owner/repo#12`, or its page). */
export function refOf(given: unknown): ItemRef | null {
  if (typeof given === "number" && Number.isInteger(given) && given > 0 && given < 1_000_000) return { number: given };
  if (typeof given !== "string") return null;
  const text = given.trim();
  if (ITEM_ID.test(text)) return { id: text };
  const number = text.match(/^#?(\d{1,6})$/);
  if (number) return { number: Number(number[1]) };
  const at = issueAt(text);
  return at ? { source: sourceKey(at) } : null;
}

/** A session as a view names it: its title, and whether it's at work. */
export interface SessionFacts { session: string; title: string; working: boolean }

/** An owner as a view names it: what it is, its title, the bot it is, and who started it. */
export interface OwnerFacts {
  owner: string;
  kind: "bot" | "session" | "group";
  title: string | null;
  bot?: { id: string; name: string };
  startedBy?: string;
}

/** Titles and who-started-whom of the sessions named, looked up where the list doesn't have them. */
export async function sessionsNamed(ids: Iterable<string>, facts: Facts, targets: Target[], cache?: Map<string, unknown>): Promise<Map<string, { title: string; startedBy?: string; bot?: { id: string; name: string } }>> {
  const byID = new Map(facts.all.map(each => [each.data.id, each.data]));
  const bots = listBots();
  const found = new Map<string, { title: string; startedBy?: string; bot?: { id: string; name: string } }>();
  for (const id of new Set(ids)) {
    if (!id.startsWith("ses_")) continue;
    let data = (byID.get(id) ?? cache?.get(id)) as Listed["data"] | undefined;
    if (!data && targets.length && !cache?.has(id)) {
      data = (await placeOfSession(id, targets).catch(() => null))?.data as Listed["data"] | undefined;
      cache?.set(id, data);
    }
    const bot = bots.find(each => each.session === id);
    const works = worksFor(data);
    const startedBy = startedByOf(data);
    found.set(id, {
      title: bot?.name ?? (data?.title || "New Session"),
      ...(startedBy ? { startedBy } : {}),
      ...(bot ? { bot: { id: bot.id, name: bot.name } } : works ? { bot: { id: works.bot, name: works.name } } : {}),
    });
  }
  return found;
}

/** What a client shows of an item in a list: everything but its body and notes (how many, and
 * the last), with its sessions' titles and which are at work. */
export interface ItemSummary {
  id: string;
  number?: number;
  wanted?: number;
  owner: string;
  title: string;
  category: string;
  order: number;
  inProgress: boolean;
  progress?: { value?: number; note?: string };
  sessions: SessionFacts[];
  noteCount: number;
  lastNote?: Note;
  fileCount: number;
  linkCount: number;
  handedBy?: string;
  source?: Source;
  /** Where its issue or pull request stands on GitHub, as last read (`github.ts`), and since when. */
  seen?: Seen;
  /** The category it's kept in, while GitHub's word makes it Done (`category` "done"). */
  keptIn?: string;
  /** On its way to a conversation on another computer. */
  handing?: { to: string; name: string };
  /** The computer it's on, when that isn't the one asked: as that computer last told it. */
  computer?: Computer;
  created: { at: number; by: Who };
  updated: { at: number; by: Who };
  doneAt?: number;
  removed?: { at: number; by: Who };
}

/** Another of your computers, as the Work Queue names it: its key, its name, what it is, and its id
 * on this Mac (a machine's), for a client to reach it. */
export interface Computer { key: string; name: string; kind: "mac" | "machine"; id?: string }

/** An item whole, as `kuvo/work-queue/items/:item` and queue_show give it. */
export interface ItemWhole extends ItemSummary {
  body: string;
  notes: Note[];
  files: KeptFile[];
  links: Link[];
  handed: { from: string; to: string; at: number }[];
}

export function summaryOf(item: Item, working: Set<string>, titles: Map<string, { title: string }>): ItemSummary {
  return withSeen({
    id: item.id,
    ...(item.number !== undefined ? { number: item.number } : {}),
    ...(item.wanted !== undefined ? { wanted: item.wanted } : {}),
    owner: item.owner,
    title: item.title,
    category: item.category,
    order: item.order,
    inProgress: inProgress(item, working),
    ...(item.progress ? { progress: item.progress } : {}),
    sessions: item.sessions.map(each => ({ session: each.session, title: titles.get(each.session)?.title ?? "New Session", working: working.has(each.session) })),
    noteCount: item.notes.length,
    ...(item.notes.length ? { lastNote: item.notes[item.notes.length - 1] } : {}),
    fileCount: item.files.length,
    linkCount: item.links.length,
    ...(item.handedBy ? { handedBy: item.handedBy } : {}),
    ...(item.source ? { source: item.source } : {}),
    ...(item.handing ? { handing: { to: item.handing.to, name: item.handing.name } } : {}),
    created: item.created,
    updated: item.updated,
    ...(item.doneAt !== undefined ? { doneAt: item.doneAt } : {}),
    ...(item.removed ? { removed: item.removed } : {}),
  });
}

export function wholeOf(item: Item, working: Set<string>, titles: Map<string, { title: string }>): ItemWhole {
  return { ...summaryOf(item, working, titles), body: item.body, notes: item.notes, files: item.files, links: item.links, handed: item.handed ?? [] };
}

/** The owners of `items`, and `owner` itself, as a view names them. */
export async function ownersOf(owner: string, items: Item[], facts: Facts, targets: Target[], cache?: Map<string, unknown>): Promise<{ owners: OwnerFacts[]; titles: Map<string, { title: string; startedBy?: string; bot?: { id: string; name: string } }> }> {
  const keys = new Set([...(owner === "all" ? [] : [owner]), ...items.map(item => item.owner), ...items.flatMap(item => item.handedBy ? [item.handedBy] : [])]);
  const named = await sessionsNamed([...keys, ...items.flatMap(item => item.sessions.map(each => each.session))], facts, targets, cache);
  const bots = listBots();
  const owners: OwnerFacts[] = [...keys].map(key => {
    if (key.startsWith("grp_")) return { owner: key, kind: "group", title: null };
    const found = named.get(key);
    const bot = bots.find(each => each.session === key);
    return {
      owner: key,
      kind: bot ? "bot" : "session",
      title: found?.title ?? null,
      ...(found?.bot ? { bot: found.bot } : {}),
      ...(found?.startedBy ? { startedBy: found.startedBy } : {}),
    };
  });
  return { owners, titles: named };
}

/** How long ago `at` was, in words, as tools say it. */
export function agoWords(at: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** An item as tools name it: an outside source's by its ref (`gh:owner/repo#12 "Title"`, its
 * number never shown again), `#243 "Title"`, or `"Title" (new, no number yet)`. (An issue's
 * title is GitHub's, as last read.) */
export const nameOf = (item: Pick<Item, "number" | "title" | "wanted" | "id"> & { source?: Source }): string =>
  item.source ? `${item.source.ref} "${seenOf(item.source)?.value?.title ?? item.title}"` : item.number !== undefined ? `#${item.number} "${item.title}"` : `"${item.title}" (${item.id}, no number yet${item.wanted ? `: asked for #${item.wanted}` : ""})`;

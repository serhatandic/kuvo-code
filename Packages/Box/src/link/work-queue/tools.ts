// The Work Queue's tools (PROTOCOL.md, "The Work Queue", "Tools"): how every agent, whatever runs
// it (the engine, Claude Code, Codex, Cursor, Grok, Antigravity), keeps its work items. The box
// lists them and carries them out (`kuvo/work-queue/tools`); the tool servers on a Mac and a machine
// only pass calls on, so they're the same on every box. A call runs only while the conversation it
// names is making it, as the vault's do.

import { HERE } from "../home";
import { listBots } from "../bots/list";
import { placeOfSession } from "../letters/letter";
import { rootOf } from "../letters/tools";
import { readProjects } from "../areas/projects";
import { callerOf, isCalling } from "../vault/who";
import { addCategory, categories, categoryNamed } from "./categories";
import { importItems, importWords, givenItems } from "./import";
import { numberWaiting, primaryOf } from "./numbers";
import { addItem, changeItem, handItem, linkSession, Refusal, removeItem, restoreItem, type Acting, type Fields, type FilePlaces } from "./ops";
import { changeQueues, readAll, type Book, type Item, type Who } from "./store";
import { agoWords, factsOf, inProgress, inView, nameOf, overseenBy, ownersOf, refOf, sessionsNamed, type Facts } from "./view";
import type { BridgeRecord, EngineRecord, Target } from "../../shared/records";
import type { Caller } from "../vault/who";

/** What a tool says back to its agent. */
export interface ToolAnswer { text: string; isError: boolean }

const said = (text: string): ToolAnswer => ({ text, isError: false });
const refused = (text: string): ToolAnswer => ({ text, isError: true });

const ITEM = { type: ["string", "integer"], description: "The item: its number, like #243 (or 243)." };
const TOP = { type: "boolean", description: "Put it at the top of its category." };
const LINKS = { type: "array", items: { anyOf: [{ type: "string" }, { type: "object", properties: { url: { type: "string" }, title: { type: "string" } }, required: ["url"] }] }, description: "Web links that belong with it: a pull request, a doc, a page (https://…)." };
const FILES = { type: "array", items: { type: "string" }, description: "Pictures or files to keep with it, as full paths: from this conversation's folder, its project or a temporary folder. Show a picture in the body with ![what it shows](file name)." };
const PROGRESS = { type: ["number", "null"], description: "How far along, from 0 to 1, only where you can count it (3 of 8 is 0.375); null takes it away." };
const PROGRESS_NOTE = { type: ["string", "null"], description: "What's being done now, in a few words, like \"Writing the tests (3 of 8)\": the user sees it under In progress." };

/** The tools, as a tool server lists them. */
export const QUEUE_TOOLS = [
  {
    name: "queue_list",
    description: "List your Work Queue: your work items, and those of the sessions you oversee, by category (In progress first, then Next, Later, any custom ones, Parked; Done only when asked), each with its number, what it's at and when it last changed. Use it before adding an item, to find one you mean, and to see what's next.",
    inputSchema: { type: "object", properties: {
      category: { type: "string", description: "Only this category: Next, Later, Parked, Done, a custom one, or In progress." },
      query: { type: "string", description: "Only items whose title or description has these words." },
      done: { type: "boolean", description: "Include Done items (the latest 30)." },
    }, additionalProperties: false },
  },
  {
    name: "queue_show",
    description: "Read one Work Queue item whole: its description, progress, notes, files, links, the sessions working on it and where each stands, and who handed it to whom.",
    inputSchema: { type: "object", properties: { item: ITEM }, required: ["item"], additionalProperties: false },
  },
  {
    name: "queue_add",
    description: "Add a work item to your Work Queue: anything the user asks you to do later, track or remember as work, and what you find needs doing. It goes in Next, at the bottom, unless you say. You get its number; refer to it as #n in what you write (the user sees a chip, never an id).",
    inputSchema: { type: "object", properties: {
      title: { type: "string", description: "What it is, in one short line." },
      body: { type: "string", description: "The description, in Markdown: what, why, what's decided, what's left." },
      category: { type: "string", description: "Next (default), Later, Parked, Done, or a custom one." },
      top: TOP,
      progress: PROGRESS,
      progress_note: PROGRESS_NOTE,
      links: LINKS,
      files: FILES,
      working: { type: "boolean", description: "You're starting on it now: links this conversation to it, so it shows In progress while you work." },
    }, required: ["title"], additionalProperties: false },
  },
  {
    name: "queue_update",
    description: "Change a Work Queue item of yours (or of a session you oversee): its title, description, category (category: done marks it done), place, progress and what's being done, a note (added, never replacing), links and files; and which sessions work on it. Link yourself with working: true when you start on it, and mark it done when it is.",
    inputSchema: { type: "object", properties: {
      item: ITEM,
      title: { type: "string" },
      body: { type: "string", description: "The whole description, in Markdown: it replaces the one there." },
      category: { type: "string", description: "Next, Later, Parked, Done, or a custom one." },
      top: TOP,
      before: { type: ["string", "integer"], description: "Put it just before this item (in the same category)." },
      after: { type: ["string", "integer"], description: "Put it just after this item (in the same category)." },
      progress: PROGRESS,
      progress_note: PROGRESS_NOTE,
      note: { type: "string", description: "A note to add, in Markdown: what happened, what you found, what's decided." },
      links: LINKS,
      remove_links: { type: "array", items: { type: "string" }, description: "Links to take away, by address." },
      files: FILES,
      remove_files: { type: "array", items: { type: "string" }, description: "Files to take away, by name." },
      working: { type: "boolean", description: "true: you're working on it now (it shows In progress while you're at work); false: you've stopped." },
      sessions: { type: "array", items: { type: "string" }, description: "Sessions working on it, by address, to link." },
      unlink: { type: "array", items: { type: "string" }, description: "Sessions to unlink, by address." },
    }, required: ["item"], additionalProperties: false },
  },
  {
    name: "queue_hand",
    description: "Hand a Work Queue item to a session on this computer (one you started, usually, right after start_session): it moves into that session's queue, linked to it, so it shows In progress while that session works. It lives once, in its queue, and stays in your view.",
    inputSchema: { type: "object", properties: {
      item: ITEM,
      to: { type: "string", description: "The session or bot, by its address (from start_session or list_sessions) or a bot's name." },
    }, required: ["item", "to"], additionalProperties: false },
  },
  {
    name: "queue_remove",
    description: "Delete a Work Queue item (the user can bring it back for 30 days), or with undo bring back one an agent deleted. Only the user brings back what the user deleted.",
    inputSchema: { type: "object", properties: { item: ITEM, undo: { type: "boolean", description: "Bring it back instead." } }, required: ["item"], additionalProperties: false },
  },
  {
    name: "queue_categories",
    description: "List the Work Queue's categories (one set for every queue), or add a custom one when the user asks for it. Renaming or removing one is the user's.",
    inputSchema: { type: "object", properties: {
      add: { type: "string", description: "A new category's name, like Bugs." },
      after: { type: "string", description: "Put it after this one (Later, or a custom one); after the other custom ones by default." },
    }, additionalProperties: false },
  },
  {
    name: "queue_import",
    description: "Import items from an old backlog (a BACKLOG.md, say) into your Work Queue, keeping their numbers: read the files yourself and give each item. Up to 200 a call. Numbers already in the queue are left out.",
    inputSchema: { type: "object", properties: {
      items: { type: "array", items: { type: "object", properties: {
        number: { type: "integer", description: "Its number, as the backlog has it (#243 is 243)." },
        title: { type: "string", description: "What it is, in one short line." },
        body: { type: "string", description: "Its whole text from the backlog, in Markdown." },
        category: { type: "string", description: "Next (default), Later, Parked, Done, or a custom one, as the backlog sorts it." },
        done: { type: "boolean", description: "It's done." },
      }, required: ["number", "title"] }, description: "The items." },
    }, required: ["items"], additionalProperties: false },
  },
];

export const QUEUE_TOOL_NAMES: readonly string[] = QUEUE_TOOLS.map(tool => tool.name);

/** What the tool servers add to what they tell agents, with the tools. */
export const QUEUE_INSTRUCTIONS = " Your Work Queue keeps your work items (queue_list, queue_add, queue_update, queue_hand): it's how you and the user track work in Kuvo Code, in place of a backlog file. When the user asks for a new item, or work comes up to do later, add it there. Refer to items as #243 (the user sees a chip); outside ones with their source, like gh:owner/repo#12. When you start on one, link yourself (working: true), keep progress_note to what's being done, and mark it done when it is; hand an item to a session you start for it with queue_hand.";

/** Who calls, as the queue knows them: the owner of the queue they write to, the session that
 * works when they say working, their name, and where their files may come from. */
interface QueueCaller {
  owner: string;
  session: string;
  who: Who;
  files: FilePlaces | null;
  seat: boolean;
}

const why = (error: unknown) => String((error as Error | null)?.message ?? error);

// Where the conversation's files may come from: its folder, and its project's other folders.
const placesOf = (folder: string | undefined): FilePlaces => ({ own: folder ?? null, others: folder ? readProjects().find(each => each.directory === folder)?.folders ?? [] : [] });

async function queueCaller(caller: Caller): Promise<QueueCaller | { refused: string }> {
  if (!caller.root) return { refused: "Only a conversation on this computer has a Work Queue here." };
  const name = caller.botName ?? caller.sessionName ?? "An agent";
  if (caller.seat) {
    if (!caller.group) return { refused: "A group chat's seat keeps the group's queue, and this one's group isn't known here." };
    return { owner: `grp_${caller.group.replace(/^grp_/, "")}`, session: caller.root, who: { session: caller.root, name }, files: placesOf(caller.folder), seat: true };
  }
  return { owner: caller.root, session: caller.root, who: { session: caller.root, name }, files: placesOf(caller.folder), seat: false };
}

// The item a call names, in the caller's view, or why not.
function itemFor(book: Pick<Book, "find">, given: unknown, caller: QueueCaller, overseen: Set<string>): Item {
  const ref = refOf(given);
  if (!ref) throw new Refusal("Say which item (item), by its number, like #243.");
  const item = book.find(ref);
  if (!item) throw new Refusal(`There's no item ${"number" in ref ? `#${ref.number}` : ref.id} in the Work Queue on ${HERE}. queue_list shows yours.`);
  if (!inView(caller.owner, item, overseen)) throw new Refusal(`${nameOf(item)} isn't in your Work Queue, nor in a session's you oversee: ask the conversation it belongs to, or the user.`);
  return item;
}

// One that's deleted, said: the user's to bring back, or an agent's.
const deletedWords = (item: Item) => ("user" in item.removed!.by
  ? `The user deleted ${nameOf(item)}: only they bring it back. Ask them if it's still needed.`
  : `${nameOf(item)} was deleted by ${item.removed!.by.name}: queue_remove with undo brings it back.`);

/** A tool's call, from the conversation `session` names: what it says back. */
export async function callQueueTool(name: unknown, args: Record<string, unknown>, session: unknown, readEngine: () => EngineRecord, readBridge: () => BridgeRecord, targets: Target[], signal?: AbortSignal): Promise<ToolAnswer> {
  if (typeof name !== "string" || !QUEUE_TOOL_NAMES.includes(name)) return refused(`There's no tool ${String(name)}.`);
  if (typeof session !== "string" || !await isCalling(session, [name], args, readEngine, readBridge)) return refused("Only a conversation's own tool call can change its Work Queue, and this one isn't running in it.");
  const found = await queueCaller(await callerOf(session, readEngine, readBridge));
  if ("refused" in found) return refused(found.refused);
  try {
    return await run(name, args, found, targets, signal);
  } catch (error) {
    if (error instanceof Refusal) return refused(error.message);
    return refused(`The Work Queue couldn't do that: ${why(error)}`);
  }
}

// A change to the queues, numbered what waits for one first.
const change = <T>(work: (book: Book) => T): T => {
  const primary = primaryOf();
  return changeQueues(book => {
    numberWaiting(book, primary, null);
    return work(book);
  });
};

async function run(name: string, args: Record<string, unknown>, caller: QueueCaller, targets: Target[], signal?: AbortSignal): Promise<ToolAnswer> {
  const now = Date.now();
  const acting: Acting = { who: caller.who, files: caller.files, now };
  const facts = await factsOf(targets, signal);
  const overseen = overseenBy(caller.owner, facts.all);
  switch (name) {
    case "queue_list":
      return said(await listWords(caller, args, facts, overseen, targets));
    case "queue_show": {
      const item = itemFor(new BookReader(), args.item, caller, overseen);
      return said(await showWords(item, facts, targets, caller));
    }
    case "queue_add": {
      const item = change(book => {
        const made = addItem(book, caller.owner, args as Fields, acting, primaryOf());
        if (args.working === true && !caller.seat) linkSession(book, made, caller.session, now);
        return made;
      });
      const where = categories().find(each => each.id === item.category)?.name ?? item.category;
      return said(item.number !== undefined
        ? `Added #${item.number} "${item.title}" to ${where}${args.working === true ? ", linked to you: it shows In progress while you work" : ""}. Refer to it as #${item.number}.`
        : `Added "${item.title}" to ${where}. It has no number yet: ${HERE} gets one from your primary computer, which isn't answering now. Name it by its title meanwhile.`);
    }
    case "queue_update": {
      const item = change(book => {
        const item = itemFor(book, args.item, caller, overseen);
        if (item.removed) throw new Refusal(deletedWords(item));
        changeItem(book, item, args as Fields, acting);
        const named = (value: unknown) => (Array.isArray(value) ? value : value === undefined ? [] : [value]).map(String).filter(each => /^ses_[A-Za-z0-9]{1,60}$/.test(each));
        if (item.category !== "done") {
          if (args.working === true && !caller.seat) linkSession(book, item, caller.session, now);
          for (const session of named(args.sessions)) linkSession(book, item, session, now);
        }
        if (args.working === false) item.sessions = item.sessions.filter(each => each.session !== caller.session);
        const unlinked = new Set(named(args.unlink));
        item.sessions = item.sessions.filter(each => !unlinked.has(each.session));
        return item;
      });
      const where = categories().find(each => each.id === item.category)?.name ?? item.category;
      return said(item.category === "done" ? `Marked ${nameOf(item)} done.` : `Changed ${nameOf(item)} (${where}${item.sessions.length ? `, ${item.sessions.length} session${item.sessions.length === 1 ? "" : "s"} linked` : ""}).`);
    }
    case "queue_hand": {
      const to = await handTarget(args.to, caller, targets);
      if ("refused" in to) return refused(to.refused);
      const item = change(book => {
        const item = itemFor(book, args.item, caller, overseen);
        if (item.removed) throw new Refusal(deletedWords(item));
        handItem(book, item, to.owner, caller.who, now);
        return item;
      });
      return said(`Handed ${nameOf(item)} to ${to.name}: it's in its queue now${to.owner.startsWith("ses_") ? ", linked to it, so it shows In progress while it works" : ""}, and stays in your view.`);
    }
    case "queue_remove": {
      const item = change(book => {
        const item = itemFor(book, args.item, caller, overseen);
        if (args.undo === true) {
          if (!item.removed) throw new Refusal(`${nameOf(item)} isn't deleted.`);
          if ("user" in item.removed.by) throw new Refusal(deletedWords(item));
          restoreItem(book, item, caller.who, now);
        } else {
          if (item.removed) throw new Refusal(`${nameOf(item)} is deleted already.`);
          removeItem(item, caller.who, now);
        }
        return item;
      });
      return said(args.undo === true ? `Brought back ${nameOf(item)}.` : `Deleted ${nameOf(item)}. The user can bring it back for 30 days.`);
    }
    case "queue_categories": {
      if (typeof args.add === "string" && args.add.trim()) {
        const outcome = addCategory(args.add, args.after);
        if ("refused" in outcome) return refused(outcome.refused);
        return said(`Added the category ${outcome.done.name}. Categories now: ${categories().map(each => each.name).join(", ")}.`);
      }
      return said(`Categories (one set for every queue): ${categories().map(each => each.name).join(", ")}. In progress isn't one you set: an item shows In progress while a session linked to it is at work.`);
    }
    case "queue_import": {
      const given = givenItems(args.items);
      if ("refused" in given) return refused(given.refused);
      const outcome = change(book => importItems(book, caller.owner, given.items, caller.who, primaryOf(), now));
      return said(importWords(outcome, given.skipped, id => categoryNamed(id)?.name ?? id));
    }
  }
  return refused(`There's no tool ${name}.`);
}

// The queues as they are, for a look that changes nothing.
class BookReader {
  private readonly items = readAll().flatMap(queue => queue.items);
  find(ref: { id?: string; number?: number }): Item | null {
    return this.items.find(item => (ref.id ? item.id === ref.id : item.number === ref.number)) ?? null;
  }
}

// Who `to` names for a hand-off: a conversation here (its root), or a bot by its name.
async function handTarget(given: unknown, caller: QueueCaller, targets: Target[]): Promise<{ owner: string; name: string } | { refused: string }> {
  const to = typeof given === "string" ? given.trim().replace(/^&/, "") : "";
  if (!to) return { refused: "Say who to hand it to (to), by a session's address or a bot's name." };
  if (/^ses_[A-Za-z0-9]{1,60}$/.test(to)) {
    const place = await placeOfSession(to, targets).catch(() => undefined);
    if (place === undefined) return { refused: `${HERE[0].toUpperCase()}${HERE.slice(1)}'s engine can't say where ${to} is now. Try again in a moment.` };
    if (place === null) return { refused: `There's no session ${to} on ${HERE}. Handing items to another computer's sessions comes later; for now, ask that session to add it with queue_add.` };
    const root = await rootOf(to, targets);
    const owner = root?.session ?? to;
    if (owner === caller.owner) return { refused: "That's your own queue." };
    const bot = listBots().find(each => each.session === owner);
    return { owner, name: bot?.name ?? (root?.place.data.title || place.data.title || "that session") };
  }
  const bots = listBots().filter(each => each.name.toLowerCase() === to.toLowerCase() && each.session);
  if (bots.length === 1) return bots[0].session === caller.owner ? { refused: "That's your own queue." } : { owner: bots[0].session!, name: bots[0].name };
  return { refused: `There's no bot called ${to} on ${HERE}. Give a session's address (from start_session or list_sessions).` };
}

// How an item reads in a list: its name, where it stands, and whose it is when it isn't yours.
function line(item: Item, facts: Facts, caller: QueueCaller, owners: Map<string, { title: string }>, now: number): string {
  const working = item.sessions.filter(each => facts.working.has(each.session));
  const state = inProgress(item, facts.working)
    ? `in progress (${working.map(each => `"${owners.get(each.session)?.title ?? "a session"}" at work`).join(", ")})${item.progress?.note ? `: ${item.progress.note}` : ""}`
    : item.category === "done" ? `done ${agoWords(item.doneAt ?? item.updated.at, now)}` : "";
  const progress = item.progress?.value !== undefined ? ` ${Math.round(item.progress.value * 100)}%` : "";
  const whose = item.owner === caller.owner ? "" : item.owner.startsWith("grp_") ? " · in the group's queue" : ` · in "${owners.get(item.owner)?.title ?? "another session"}" (${item.owner})`;
  return `- ${nameOf(item)}${state ? ` · ${state}` : ""}${progress}${whose} · updated ${agoWords(item.updated.at, now)}`;
}

async function listWords(caller: QueueCaller, args: Record<string, unknown>, facts: Facts, overseen: Set<string>, targets: Target[]): Promise<string> {
  const now = Date.now();
  const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
  const wanted = typeof args.category === "string" && args.category.trim() ? args.category.trim() : null;
  const progressOnly = wanted !== null && /^in[ -]?progress$/i.test(wanted);
  const category = wanted && !progressOnly ? categoryNamed(wanted) : null;
  if (wanted && !progressOnly && !category) throw new Refusal(`There's no category ${wanted}: queue_categories lists them.`);
  let items = readAll().flatMap(queue => queue.items).filter(item => !item.removed && inView(caller.owner, item, overseen));
  if (query) items = items.filter(item => item.title.toLowerCase().includes(query) || item.body.toLowerCase().includes(query));
  const { titles } = await ownersOf(caller.owner, items, facts, targets);
  const sections: string[] = [];
  const shown = (list: Item[]) => list.sort((a, b) => a.order - b.order).map(item => line(item, facts, caller, titles, now));
  const going = items.filter(item => inProgress(item, facts.working));
  if (!category && going.length) sections.push(`In progress:\n${shown(going).join("\n")}`);
  for (const each of categories()) {
    if (progressOnly || (category && category.id !== each.id)) continue;
    if (each.id === "done" && !category && args.done !== true) continue;
    let list = items.filter(item => item.category === each.id && (category || !inProgress(item, facts.working)));
    if (each.id === "done") list = list.sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0)).slice(0, 30);
    if (list.length) sections.push(`${each.name}:\n${(each.id === "done" ? list.map(item => line(item, facts, caller, titles, now)) : shown(list)).join("\n")}`);
  }
  const waiting = items.filter(item => item.number === undefined).length;
  const open = items.filter(item => item.category !== "done").length;
  if (!sections.length) return query || wanted ? "Nothing in your Work Queue matches." : "Your Work Queue is empty. Add items with queue_add.";
  return `Your Work Queue (${open} open${waiting ? `, ${waiting} waiting for a number` : ""}):\n\n${sections.join("\n\n")}`;
}

async function showWords(item: Item, facts: Facts, targets: Target[], caller: QueueCaller): Promise<string> {
  const now = Date.now();
  const named = await sessionsNamed([item.owner, ...item.sessions.map(each => each.session), ...(item.handed ?? []).flatMap(each => [each.from, each.to])], facts, targets);
  const title = (key: string) => (key.startsWith("grp_") ? "the group chat" : `"${named.get(key)?.title ?? "a session"}"`);
  const category = categories().find(each => each.id === item.category)?.name ?? item.category;
  const parts = [
    `${nameOf(item)} · ${inProgress(item, facts.working) ? `In progress (kept in ${category})` : category}${item.removed ? " · DELETED" : ""}${item.owner === caller.owner ? "" : ` · in ${title(item.owner)}'s queue (${item.owner})`}`,
    `Added ${agoWords(item.created.at, now)} by ${"user" in item.created.by ? "the user" : item.created.by.name}; updated ${agoWords(item.updated.at, now)}.`,
    item.progress ? `Progress: ${item.progress.value !== undefined ? `${Math.round(item.progress.value * 100)}%` : ""}${item.progress.value !== undefined && item.progress.note ? " · " : ""}${item.progress.note ?? ""}` : "",
    item.sessions.length ? `Sessions on it: ${item.sessions.map(each => `${title(each.session)} (${each.session}) ${facts.working.has(each.session) ? "at work" : "not at work"}`).join("; ")}` : "",
    item.body ? `\n${item.body}` : "",
    item.links.length ? `\nLinks:\n${item.links.map(each => `- ${each.title ? `${each.title}: ` : ""}${each.url}`).join("\n")}` : "",
    item.files.length ? `\nFiles: ${item.files.map(each => each.name).join(", ")}` : "",
    item.notes.length ? `\nNotes:\n${item.notes.slice(-20).map(each => `- ${agoWords(each.at, now)}, ${"user" in each.by ? "the user" : each.by.name}: ${each.text}`).join("\n")}` : "",
    item.handed?.length ? `\nHanded: ${item.handed.map(each => `${title(each.from)} → ${title(each.to)} ${agoWords(each.at, now)}`).join("; ")}` : "",
  ];
  return parts.filter(Boolean).join("\n");
}


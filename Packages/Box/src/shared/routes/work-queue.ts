// The Work Queue (PROTOCOL.md, "The Work Queue"): an owner's view and its events, one item whole,
// what `#n` refs name, the categories, and what you do from a client. Times are milliseconds since
// 1970.

import { any, bool, BYTES, list, map, nullable, number, object, oneOf, type RouteShape, string, words } from "../shape";

// (You, an agent, or another shape kept as it came: an outside tracker's change, later.)
const WHO = oneOf(object({ user: bool }), object({ session: string, name: string }), map(any));
const STAMP = object({ at: number, by: WHO });
const NOTE = object({ at: number, by: WHO, text: string });
const PROGRESS = object({ "value?": number, "note?": string });

/** An outside source's item (an issue or a pull request), named by its ref, never numbered. */
const SOURCE = object({ kind: string, ref: string, "url?": string, "host?": string, "id?": string });
/** Another of your computers, the one an item is on. */
const COMPUTER = object({ key: string, name: string, kind: words("mac", "machine"), "id?": string });

export const QUEUE_CATEGORY = object({ id: string, name: string, builtIn: bool });

/** An item as a list shows it: everything but its body and notes (how many, and the last). */
export const QUEUE_ITEM = object({
  id: string,
  "number?": number,
  "wanted?": number,
  owner: string,
  title: string,
  category: string,
  order: number,
  inProgress: bool,
  "progress?": PROGRESS,
  sessions: list(object({ session: string, title: string, working: bool })),
  noteCount: number,
  "lastNote?": NOTE,
  fileCount: number,
  linkCount: number,
  "handedBy?": string,
  "source?": SOURCE,
  "handing?": object({ to: string, name: string }),
  "computer?": COMPUTER,
  created: STAMP,
  updated: STAMP,
  "doneAt?": number,
  "removed?": STAMP,
});

/** An item whole. */
export const QUEUE_ITEM_WHOLE = object({
  ...QUEUE_ITEM.object,
  body: string,
  notes: list(NOTE),
  files: list(object({ name: string, size: number, type: string, at: number })),
  links: list(object({ url: string, "title?": string, "kind?": string, "ref?": string })),
  handed: list(object({ from: string, to: string, at: number })),
});

/** An owner in a view: what it is, its title, the bot it is, and who started it. */
export const QUEUE_OWNER = object({ owner: string, kind: words("bot", "session", "group"), title: nullable(string), "bot?": object({ id: string, name: string }), "startedBy?": string });

/** An owner's view. */
export const QUEUE_VIEW = object({ owner: string, categories: list(QUEUE_CATEGORY), items: list(QUEUE_ITEM), owners: list(QUEUE_OWNER), removed: list(QUEUE_ITEM),
  computers: list(object({ ...COMPUTER.object, at: number })) });

const REF = nullable(object({ id: string, "number?": number, "source?": SOURCE, title: string, category: string, inProgress: bool, owner: string, "removed?": bool, "computer?": COMPUTER }));

// An item on another of your computers: changed there.
const ON_ANOTHER = object({ message: string, computer: COMPUTER });

export const WORK_QUEUE_ROUTES: RouteShape[] = [
  { route: "GET kuvo/work-queue", answers: { 200: QUEUE_VIEW } },
  { route: "GET kuvo/work-queue/events", answers: { 200: QUEUE_VIEW } },
  { route: "GET kuvo/work-queue/tools", answers: { 200: object({ tools: list(any), instructions: string }) } },
  { route: "POST kuvo/work-queue/tools", answers: { 200: object({ text: string, isError: bool }) } },
  { route: "GET kuvo/work-queue/refs", answers: { 200: object({ refs: map(REF) }) } },
  { route: "POST kuvo/work-queue/refs", answers: { 200: object({ refs: map(REF) }) } },
  { route: "GET kuvo/work-queue/categories", answers: { 200: object({ categories: list(QUEUE_CATEGORY) }) } },
  { route: "POST kuvo/work-queue/categories", answers: { 200: object({ categories: list(QUEUE_CATEGORY) }) } },
  { route: "POST kuvo/work-queue/import", answers: { 200: object({ added: number, byCategory: map(number), waiting: number, skipped: list(string), said: string }) } },
  { route: "GET kuvo/work-queue/items/:item", answers: { 200: object({ item: QUEUE_ITEM_WHOLE }) } },
  { route: "GET kuvo/work-queue/items/:item/files/:name", answers: { 200: BYTES } },
  { route: "POST kuvo/work-queue/items/:item/move", answers: { 200: object({ item: QUEUE_ITEM }), 409: ON_ANOTHER } },
  { route: "POST kuvo/work-queue/items/:item/restore", answers: { 200: object({ item: QUEUE_ITEM }), 409: ON_ANOTHER } },
  { route: "DELETE kuvo/work-queue/items/:item", answers: { 200: object({ item: QUEUE_ITEM }), 409: ON_ANOTHER } },
];



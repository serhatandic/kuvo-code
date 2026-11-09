// The Work Queue's routes (PROTOCOL.md, "The Work Queue"): an owner's view and its events, one
// item whole and its files, what `#n` refs name (for chips), the categories, and what you do from a
// client: reorder, move to a category, delete, bring back, and import an old backlog. Clients never
// change an item's content (agents do, through the tools, `kuvo/work-queue/tools`).

import fs from "node:fs";
import path from "node:path";
import { isObject, parsed } from "../../shared/json";
import { watchFolders } from "../follow";
import { targetsOf } from "../letters/tools";
import { atWorkNow } from "../work/background";
import { addCategory, categories, removeCategory, renameCategory } from "../work-queue/categories";
import { importItems, importWords, parseBacklog, readBacklogFiles } from "../work-queue/import";
import { numberWaiting, primaryOf } from "../work-queue/numbers";
import { categoryFor, FILE_NAME, Refusal, removeItem, restoreItem } from "../work-queue/ops";
import { changeQueues, filesOf, OWNER, placeBeside, placeIn, queueFollowers, readAll, WORK_QUEUE, type Item } from "../work-queue/store";
import { callQueueTool, QUEUE_INSTRUCTIONS, QUEUE_TOOLS } from "../work-queue/tools";
import { factsOf, inProgress, inView, overseenBy, ownersOf, refOf, summaryOf, wholeOf, type Facts } from "../work-queue/view";
import type { AnswerPiece, RouteContext } from "../server/context";
import type { Target } from "../../shared/records";

export const WORK_QUEUE_ROUTE = /^kuvo\/work-queue(?:\/(tools|events|refs|categories|import|items\/([^/]+)(?:\/(move|restore|files\/([^/]+)))?))?$/;

const YOU = { user: true } as const;
const ONLY_CLIENTS = "Only Kuvo Code on your Mac or iPhone can do this: agents change the Work Queue with their tools.";

// A paired phone, this Mac's app, or Kuvo Code on another computer (`box route`): you.
const fromClient = ({ request, phone }: RouteContext) => Boolean(phone?.key || request.fromApp || request.fromMac);
const queryOf = (request: RouteContext["request"]) => new URLSearchParams(request.path.split("?")[1] ?? "");

/** An owner's view, as `kuvo/work-queue` gives it: the categories, its items and those it oversees
 * or handed on (summaries), whose each is, and what's deleted among them. */
export async function viewOf(owner: string, targets: Target[], facts?: Facts, signal?: AbortSignal) {
  const known = facts ?? await factsOf(targets, signal);
  const overseen = overseenBy(owner, known.all);
  const all = readAll().flatMap(queue => queue.items).filter(item => inView(owner, item, overseen));
  const { owners, titles } = await ownersOf(owner, all, known, targets);
  // (In the categories' order, then each one's own.)
  const place = new Map(categories().map((each, index) => [each.id, index]));
  const sorted = (items: Item[]) => items.sort((a, b) => (place.get(a.category) ?? 99) - (place.get(b.category) ?? 99) || a.order - b.order).map(item => summaryOf(item, known.working, titles));
  return {
    owner,
    categories: categories(),
    items: sorted(all.filter(item => !item.removed)),
    owners,
    removed: all.filter(item => item.removed).sort((a, b) => b.removed!.at - a.removed!.at).map(item => summaryOf(item, known.working, titles)),
  };
}

// What a client's own change says: the item as it is now, or why not.
function changed(work: () => Item, json: RouteContext["json"]): AnswerPiece[] {
  try {
    const item = work();
    return json(200, { item: summaryOf(item, new Set(), new Map()) });
  } catch (error) {
    if (error instanceof Refusal) return json(error.message.startsWith("There's no item") ? 404 : 400, { message: error.message });
    throw error;
  }
}

export async function* workQueueRoute(context: RouteContext, match: RegExpMatchArray): AsyncGenerator<AnswerPiece> {
  const { request, json, signal, readEngine, readBridge, bridge } = context;
  const method = request.method.toUpperCase();
  const [, part, rawItem, action, rawFile] = match;
  const targets = targetsOf({ readEngine, bridge });
  const body = parsed(request.body);
  const given = isObject(body) ? body : {};

  if (part === "tools") {
    if (method === "GET") return yield* json(200, { tools: QUEUE_TOOLS, instructions: QUEUE_INSTRUCTIONS });
    if (method !== "POST") return yield* json(405, {});
    const args = isObject(given.arguments) ? given.arguments : {};
    return yield* json(200, await callQueueTool(given.name, args, given.session, readEngine, readBridge, targets, signal ?? undefined));
  }

  if (part === "refs") {
    if (method !== "GET") return yield* json(405, {});
    const wanted = (queryOf(request).get("refs") ?? "").split(",").map(each => each.trim()).filter(Boolean).slice(0, 200);
    const items = readAll().flatMap(queue => queue.items);
    const facts = await factsOf(targets, signal ?? undefined);
    const refs: Record<string, unknown> = {};
    for (const ref of wanted) {
      const named = refOf(ref);
      const item = named ? items.find(each => ("id" in named ? each.id === named.id : each.number === named.number)) : undefined;
      refs[ref] = item ? { id: item.id, ...(item.number !== undefined ? { number: item.number } : {}), title: item.title, category: item.category, inProgress: inProgress(item, facts.working), owner: item.owner, ...(item.removed ? { removed: true } : {}) } : null;
    }
    return yield* json(200, { refs });
  }

  if (part === "categories") {
    if (method === "GET") return yield* json(200, { categories: categories() });
    if (method !== "POST") return yield* json(405, {});
    if (!fromClient(context)) return yield* json(403, { message: ONLY_CLIENTS });
    const used = (id: string) => readAll().flatMap(queue => queue.items).filter(item => item.category === id && !item.removed).length;
    const outcome = typeof given.add === "string" ? addCategory(given.add, given.after)
      : given.rename !== undefined ? renameCategory(given.rename, given.to)
      : given.remove !== undefined ? removeCategory(given.remove, used)
      : { refused: "Send {add, after}, {rename, to} or {remove}." };
    if ("refused" in outcome) return yield* json(400, { message: outcome.refused });
    return yield* json(200, { categories: categories() });
  }

  if (part === "import") {
    if (method !== "POST") return yield* json(405, {});
    if (!fromClient(context)) return yield* json(403, { message: ONLY_CLIENTS });
    const owner = typeof given.owner === "string" && OWNER.test(given.owner) ? given.owner : null;
    if (!owner) return yield* json(400, { message: "Say whose queue it goes in (owner): a conversation's address." });
    const read = readBacklogFiles(given.files);
    if ("refused" in read) return yield* json(400, { message: read.refused });
    const { items, skipped } = parseBacklog(read.texts);
    const outcome = changeQueues(book => importItems(book, owner, items, YOU, primaryOf()));
    const names = (id: string) => categories().find(each => each.id === id)?.name ?? id;
    return yield* json(200, { added: outcome.added, byCategory: outcome.byCategory, waiting: outcome.waiting, skipped: [...skipped, ...outcome.skipped], said: importWords(outcome, skipped, names) });
  }

  if (part === "events" || part === undefined) {
    if (method !== "GET") return yield* json(405, {});
    const owner = queryOf(request).get("owner") ?? "";
    if (!OWNER.test(owner)) return yield* json(400, { message: "Say whose queue (owner): a conversation's address or a group chat's id." });
    if (part === undefined) return yield* json(200, await viewOf(owner, targets, undefined, signal ?? undefined));
    yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
    return yield* followView(owner, targets, signal ?? undefined);
  }

  // One item.
  const ref = refOf(decodeURIComponent(rawItem ?? ""));
  if (!ref) return yield* json(404, { message: "There's no such item." });
  const find = (items: Item[]) => items.find(each => ("id" in ref ? each.id === ref.id : each.number === ref.number)) ?? null;
  if (action === undefined && method === "GET") {
    const item = find(readAll().flatMap(queue => queue.items));
    if (!item) return yield* json(404, { message: "There's no such item." });
    const facts = await factsOf(targets, signal ?? undefined);
    const { titles } = await ownersOf(item.owner, [item], facts, targets);
    return yield* json(200, { item: wholeOf(item, facts.working, titles) });
  }
  if (action?.startsWith("files/") && method === "GET") {
    const name = decodeURIComponent(rawFile ?? "");
    const item = find(readAll().flatMap(queue => queue.items));
    const kept = item?.files.find(each => each.name === name);
    if (!item || !kept || !FILE_NAME.test(name)) return yield* json(404, { message: "There's no such file." });
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(path.join(filesOf(item.id), name));
    } catch {
      return yield* json(404, { message: "There's no such file." });
    }
    yield { head: { status: 200, headers: { "content-type": kept.type } } };
    return yield { body: bytes };
  }
  if (!fromClient(context)) return yield* json(403, { message: ONLY_CLIENTS });
  const now = Date.now();
  const primary = primaryOf();
  const inBook = (work: (item: Item, book: Parameters<Parameters<typeof changeQueues>[0]>[0]) => void) => () => changeQueues(book => {
    numberWaiting(book, primary, null);
    const item = find(book.items());
    if (!item) throw new Refusal("There's no item like that.");
    work(item, book);
    return item;
  });
  if (action === undefined && method === "DELETE") {
    return yield* changed(inBook(item => {
      if (item.removed) throw new Refusal("It's deleted already.");
      removeItem(item, YOU, now);
    }), json);
  }
  if (action === "restore" && method === "POST") {
    return yield* changed(inBook((item, book) => {
      if (!item.removed) throw new Refusal("It isn't deleted.");
      restoreItem(book, item, YOU, now);
    }), json);
  }
  if (action === "move" && method === "POST") {
    return yield* changed(inBook((item, book) => {
      if (item.removed) throw new Refusal("It's deleted: bring it back first.");
      if (given.category !== undefined) {
        const category = categoryFor(given.category);
        if (category !== item.category) {
          item.category = category;
          item.order = placeIn(book.items(), category, { top: given.top === true });
          if (category === "done") {
            item.doneAt = now;
            item.sessions = [];
          } else {
            delete item.doneAt;
          }
        }
      }
      const beside = given.before ?? given.after;
      if (beside !== undefined) {
        const named = refOf(beside);
        const other = named && book.items().find(each => !each.removed && ("id" in named ? each.id === named.id : each.number === named.number));
        if (!other || other.id === item.id) throw new Refusal("There's no item like that to put it beside.");
        if (other.category !== item.category) throw new Refusal("That item is in another category.");
        item.order = placeBeside(book.items(), other, given.after !== undefined);
      } else if (given.top === true && given.category === undefined) {
        item.order = placeIn(book.items().filter(each => each.id !== item.id), item.category, { top: true });
      }
      item.updated = { at: now, by: YOU };
    }), json);
  }
  return yield* json(405, {});
}

// An owner's view, a line now and one each time it changes: a change to the queues (here, or by
// another process: its files), or a session linked to one of its items starting or stopping work
// (looked at every few seconds).
async function* followView(owner: string, targets: Target[], signal?: AbortSignal): AsyncGenerator<AnswerPiece> {
  let wake: (() => void) | null = null;
  let dirty = true;
  const told = () => {
    dirty = true;
    wake?.();
  };
  queueFollowers.add(told);
  const watching = watchFolders([path.join(WORK_QUEUE, "queues")], told, { recursive: false });
  signal?.addEventListener("abort", () => wake?.(), { once: true });
  let last = "";
  let facts: Facts | null = null;
  let factsAt = 0;
  try {
    while (!signal?.aborted) {
      // Who's under whom, looked at again with each change and every half minute; who's at work,
      // each time.
      if (!facts || dirty || Date.now() - factsAt > 30_000) {
        facts = await factsOf(targets, signal);
        factsAt = Date.now();
      } else {
        const known: Facts = facts;
        facts = { all: known.all, working: await atWorkNow(targets, signal).catch(() => known.working) };
      }
      dirty = false;
      const line = JSON.stringify(await viewOf(owner, targets, facts, signal));
      if (line !== last) {
        yield { body: Buffer.from(line + "\n") };
        last = line;
      }
      if (signal?.aborted) break;
      await new Promise<void>(done => {
        const timer = setTimeout(done, 3000);
        wake = () => { clearTimeout(timer); done(); };
      });
      wake = null;
    }
  } finally {
    queueFollowers.delete(told);
    watching.close();
  }
}

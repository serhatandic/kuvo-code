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
import { provedRequest } from "./vault";
import { addCategory, categories, removeCategory, renameCategory } from "../work-queue/categories";
import { importItems, importWords, parseBacklog, readBacklogFiles } from "../work-queue/import";
import { primaryOf } from "../work-queue/numbers";
import { itemElsewhere, itemsElsewhere, tellQueuesAgain } from "../work-queue/across";
import { Refusal, refuseMoving } from "../work-queue/ops";
import { TOLD } from "../work-queue/told";
import { readLink } from "../state";
import { allItems, changeQueues, FILE_NAME, filesOf, matching, OWNER, queueFollowers, readAll, WORK_QUEUE, type Item } from "../work-queue/store";
import { readSeen, SEEN_FILE } from "../work-queue/github";
import { callQueueTool, QUEUE_INSTRUCTIONS, QUEUE_TOOLS } from "../work-queue/tools";
import { factsOf, inView, linkedTo, nameOf, overseenBy, ownersOf, refOf, summaryOf, type Facts, type ItemSummary } from "../work-queue/view";
import { forwardAct, type Act, type Acted } from "../work-queue/forward";
import { actHere, GITHUB_WAIT } from "../work-queue/acts";
import type { AnswerPiece, RouteContext } from "../server/context";
import type { Target } from "../../shared/records";

export const WORK_QUEUE_ROUTE = /^kuvo\/work-queue(?:\/(tools|events|refs|categories|import|items\/([^/]+)(?:\/(move|restore|files\/([^/]+)))?))?$/;

const YOU = { user: true } as const;
// Every queue on the box at once, as the panel's All shows it.
const ALL = "all";
const ONLY_CLIENTS = "Only Kuvo Code on your Mac or iPhone can do this: agents change the Work Queue with their tools.";
// A Mac over SSH whose proof didn't hold (too old, its clock off, or a Mac that didn't set this one up).
const NOT_PROVED = "This machine couldn't tell the request was from the Mac that set it up (its proof was missing or too old; check both computers' clocks): try again.";

// A paired phone, this Mac's app, or Kuvo Code on another computer (`box route`) with its Mac's
// proof for this request alone, as the vault takes it (anyone on this computer can run `box route`,
// an agent's command too): you.
const notClient = ({ request }: RouteContext) => (request.fromMac && request.headers["x-kuvo-vault-proof"] ? NOT_PROVED : ONLY_CLIENTS);
const fromClient = ({ request, phone }: RouteContext) => Boolean(phone?.key || request.fromApp || (request.fromMac && provedRequest(request)));
const queryOf = (request: RouteContext["request"]) => new URLSearchParams(request.path.split("?")[1] ?? "");

/** An owner's view, as `kuvo/work-queue` gives it: the categories, its items and those it oversees
 * or handed on (summaries), those linked to it that are someone else's (what it's working on: seen
 * here, changed only by their owner's side), whose each is, and what's deleted among them. `all` is
 * every item on the box, whoever's it is. Its issues and pull requests are read from GitHub where
 * that's due, waiting `wait` ms at most. */
export async function viewOf(owner: string, targets: Target[], facts?: Facts, signal?: AbortSignal, cache?: Map<string, unknown>, wait = GITHUB_WAIT) {
  const known = facts ?? await factsOf(targets, signal);
  const overseen = owner === ALL ? new Set<string>() : overseenBy(owner, known.all);
  const here = allItems();
  // (A queue of a kind a newer box keeps isn't one to show.)
  const all = here.filter(item => owner === ALL || inView(owner, item, overseen) || linkedTo(owner, item));
  // (What's shown, here or told by another computer: GitHub is read for it, only now.)
  // (Another computer's as it told them: when it last asked GitHub decides whether this box does.)
  await readSeen([...all, ...itemsElsewhere(owner, readLink(), undefined, undefined, { asTold: true, linked: true }).items], wait);
  const { owners, titles } = await ownersOf(owner, all, known, targets, cache);
  // Your other computers' items in this view, as each last told them (one deleted here that's live
  // there, a hand-off called off that had got there, is theirs).
  const elsewhere = itemsElsewhere(owner, readLink(), new Set(here.filter(item => !item.removed).map(item => item.id)), new Set(here.filter(item => item.removed).map(item => item.id)), { linked: true });
  const named = new Set(owners.map(each => each.owner));
  // The categories: this box's, then custom ones only another computer has, before Parked.
  const own = categories();
  const others = elsewhere.categories.filter(each => !own.some(mine => mine.id === each.id)).map(each => ({ ...each, builtIn: false }));
  const shown = [...own.slice(0, -2), ...others, ...own.slice(-2)];
  const place = new Map(shown.map((each, index) => [each.id, index]));
  // (In the categories' order, then each one's own.)
  // (Each computer keeps its own order: within a category, this box's first, then each other
  // computer's, by name.)
  const computerOf = (item: { computer?: { name: string; key: string } }) => (item.computer ? `1 ${item.computer.name} ${item.computer.key}` : "0");
  const byPlace = <T extends { category: string; order: number; computer?: { name: string; key: string } }>(items: T[]) =>
    items.sort((a, b) => (place.get(a.category) ?? 99) - (place.get(b.category) ?? 99) || computerOf(a).localeCompare(computerOf(b)) || a.order - b.order);
  return {
    owner,
    categories: shown,
    items: byPlace([...all.filter(item => !item.removed).map(item => summaryOf(item, known.working, titles)), ...elsewhere.items.map(({ handedFrom: _, ...item }) => item)]),
    owners: [...owners, ...elsewhere.owners.filter(each => !named.has(each.owner))],
    removed: all.filter(item => item.removed).sort((a, b) => b.removed!.at - a.removed!.at).map(item => summaryOf(item, known.working, titles)),
    computers: elsewhere.computers,
  };
}

// What a chip shows of an item (a summary): its number (or its outside source, and what GitHub says
// of it), title, where it stands, whose.
const refFacts = (item: Pick<ItemSummary, "id" | "number" | "title" | "category" | "owner" | "inProgress" | "source" | "seen" | "struck" | "closesOn" | "removed">) => ({
  id: item.id,
  ...(item.number !== undefined ? { number: item.number } : {}),
  ...(item.source ? { source: item.source } : {}),
  ...(item.seen ? { seen: item.seen } : {}),
  ...(item.struck ? { struck: true } : {}),
  ...(item.closesOn ? { closesOn: item.closesOn } : {}),
  title: item.title,
  category: item.category,
  inProgress: item.inProgress,
  owner: item.owner,
  ...(item.removed ? { removed: true } : {}),
});

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
    // (GET with `refs=243,12`; POST `{refs: [...], conversation?}`, a list, so a ref with a comma in
    // it, an outside one later, goes whole.)
    if (method !== "GET" && method !== "POST") return yield* json(405, {});
    const listed = method === "POST" ? (Array.isArray(given.refs) ? given.refs : []) : (queryOf(request).get("refs") ?? "").split(",");
    const wanted = listed.filter((each): each is string => typeof each === "string").map(each => each.trim()).filter(each => each && each.length <= 300).slice(0, 200);
    const items = allItems();
    const facts = await factsOf(targets, signal ?? undefined);
    const found = wanted.map(ref => {
      const named = refOf(ref);
      const item = named ? matching(items, named)[0] : undefined;
      // One on another of your computers, as it last told it.
      return { ref, item, far: !item && named ? itemElsewhere(named, readLink(), { asTold: true }) : null };
    });
    // (Their issues and pull requests read from GitHub where that's due: the chips are on screen.)
    await readSeen(found.flatMap(each => [each.item ?? each.far].filter(Boolean) as { source?: Item["source"] }[]), GITHUB_WAIT);
    const refs: Record<string, unknown> = {};
    for (const { ref, item, far } of found) {
      const again = far ? itemElsewhere({ id: far.id }) : null;
      refs[ref] = item ? refFacts(summaryOf(item, facts.working, new Map())) : again ? { ...refFacts(again), computer: again.computer } : null;
    }
    return yield* json(200, { refs });
  }

  if (part === "categories") {
    if (method === "GET") return yield* json(200, { categories: categories() });
    if (method !== "POST") return yield* json(405, {});
    if (!fromClient(context)) return yield* json(403, { message: notClient(context) });
    // (Deleted ones too: brought back, they'd have nowhere to go.)
    const used = (id: string) => readAll().flatMap(queue => queue.items).filter(item => item.category === id).length;
    const outcome = typeof given.add === "string" ? addCategory(given.add, given.after)
      : given.rename !== undefined ? renameCategory(given.rename, given.to)
      : given.remove !== undefined ? removeCategory(given.remove, used)
      : { refused: "Send {add, after}, {rename, to} or {remove}." };
    if ("refused" in outcome) return yield* json(400, { message: outcome.refused });
    tellQueuesAgain();
    return yield* json(200, { categories: categories() });
  }

  if (part === "import") {
    if (method !== "POST") return yield* json(405, {});
    if (!fromClient(context)) return yield* json(403, { message: notClient(context) });
    const owner = typeof given.owner === "string" && OWNER.test(given.owner) ? given.owner : null;
    if (!owner) return yield* json(400, { message: "Say whose queue it goes in (owner): a conversation's address." });
    try {
      refuseMoving([owner]);
    } catch (error) {
      return yield* json(409, { message: (error as Error).message });
    }
    const read = readBacklogFiles(given.files);
    if ("refused" in read) return yield* json(400, { message: read.refused });
    const { items, skipped } = parseBacklog(read.texts);
    let outcome: ReturnType<typeof importItems>;
    try {
      outcome = changeQueues(book => importItems(book, owner, items, YOU, primaryOf()));
    } catch (error) {
      if (error instanceof Refusal) return yield* json(400, { message: error.message });
      throw error;
    }
    const names = (id: string) => categories().find(each => each.id === id)?.name ?? id;
    return yield* json(200, { added: outcome.added, byCategory: outcome.byCategory, waiting: outcome.waiting, skipped: [...skipped, ...outcome.already.map(n => `#${n} (already in the Work Queue here)`), ...outcome.skipped], said: importWords(outcome, skipped, names) });
  }

  if (part === "events" || part === undefined) {
    if (method !== "GET") return yield* json(405, {});
    const owner = queryOf(request).get("owner") ?? "";
    if (!OWNER.test(owner) && owner !== ALL) return yield* json(400, { message: "Say whose queue (owner): a conversation's address, a group chat's id, or all." });
    if (part === undefined) return yield* json(200, await viewOf(owner, targets, undefined, signal ?? undefined));
    yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
    return yield* followView(owner, targets, signal ?? undefined);
  }

  // One item.
  let named = "";
  try { named = decodeURIComponent(rawItem ?? ""); } catch {}
  const ref = refOf(named);
  if (!ref) return yield* json(404, { message: "There's no such item." });
  const find = (items: Item[]) => matching(items, ref)[0] ?? null;
  if (action === undefined && method === "GET") {
    if (find(allItems())) return yield* answered(await actHere({ method: "GET", ref, targets, signal }), json);
    // One on another of your computers: whole, as that computer's box answers for a client (`told:
    // false`); else as it last told it (`told: true`), without what only it keeps (its description,
    // notes, what happened to it, files, links).
    let far = itemElsewhere(ref);
    if (!far) return yield* json(404, { message: "There's no such item." });
    if (fromClient(context)) {
      const there = await forwardAct(far.computer, nameOf(far), { method: "GET", item: far.id }, signal);
      const whole = there.status === 200 && "value" in there && isObject(there.value) && isObject(there.value.item) ? there.value.item : null;
      if (whole) return yield* json(200, { item: { ...whole, computer: far.computer, told: false } });
    }
    await readSeen([itemElsewhere(ref, readLink(), { asTold: true }) ?? far], GITHUB_WAIT);
    far = itemElsewhere({ id: far.id }) ?? far;
    const { handedFrom: _, ...summary } = far;
    return yield* json(200, { item: { ...summary, body: "", notes: [], events: [], files: [], links: [], handed: [], told: true } });
  }
  if (action?.startsWith("files/") && method === "GET") {
    const name = decodeURIComponent(rawFile ?? "");
    const item = find(allItems());
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
  const asked: Pick<Act, "method" | "action"> | null = method === "DELETE" && action === undefined ? { method: "DELETE" }
    : method === "POST" && (action === "move" || action === "restore") ? { method: "POST", action }
    : null;
  if (!asked) return yield* json(405, {});
  if (!fromClient(context)) return yield* json(403, { message: notClient(context) });
  // One on another of your computers is done there, by that computer's box: this one hands it on
  // and answers with what it said (a client never works out where an item is).
  const far = !find(allItems()) ? itemElsewhere(ref) : null;
  if (!far) return yield* answered(await actHere({ ...asked, ref, given, targets, signal }), json);
  const { category, before, after, top } = given;
  const there = await forwardAct(far.computer, nameOf(far), { ...asked, item: far.id, ...(asked.action === "move" ? { body: { category, before, after, top } } : {}) }, signal);
  if ("refused" in there) return yield* json(there.status, { message: there.refused, computer: far.computer });
  // (As this box names that computer, so a client knows where it is.)
  const value = isObject(there.value) && isObject(there.value.item) ? { ...there.value, item: { ...there.value.item, computer: far.computer } } : there.value;
  return yield* json(there.status, value);
}

const answered = (answer: Acted, json: RouteContext["json"]) => json(answer.status, answer.value);

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
  // (The queues, what your other computers told of theirs, and the categories beside them: not the
  // locks and the numbers there.)
  try { fs.mkdirSync(TOLD, { recursive: true, mode: 0o700 }); } catch {}
  // (What a watch may have missed, as one started or stopped: read again now, as every few seconds,
  // but who's under whom only as they change.)
  const looked = () => wake?.();
  const queuesWatch = watchFolders([path.join(WORK_QUEUE, "queues"), TOLD], told, { recursive: false, missed: looked });
  // (And what GitHub said of its issues and pull requests, read as it's shown.)
  const categoriesWatch = watchFolders([WORK_QUEUE], ((_: unknown, name: unknown) => { if (["categories.json", path.basename(SEEN_FILE)].includes(String(name ?? ""))) told(); }) as () => void, { recursive: false, missed: looked });
  const watching = { close: () => { queuesWatch.close(); categoriesWatch.close(); } };
  signal?.addEventListener("abort", () => wake?.(), { once: true });
  let last = "";
  let facts: Facts | null = null;
  let factsAt = 0;
  // Titles of sessions the list doesn't have, looked up once a half minute at most.
  let titles = new Map<string, unknown>();
  try {
    while (!signal?.aborted) {
      // Who's under whom, looked at again with each change and every half minute; who's at work,
      // each time.
      if (!facts || dirty || Date.now() - factsAt > 30_000) {
        facts = await factsOf(targets, signal);
        factsAt = Date.now();
        titles = new Map();
      } else {
        const known: Facts = facts;
        facts = { all: known.all, working: await atWorkNow(targets, signal).catch(() => known.working) };
      }
      dirty = false;
      // (GitHub isn't waited for: what it says comes as a line of its own once it's read.)
      const line = JSON.stringify(await viewOf(owner, targets, facts, signal, titles, 0));
      if (line !== last) {
        yield { body: Buffer.from(line + "\n") };
        last = line;
      }
      if (signal?.aborted || dirty) continue;
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

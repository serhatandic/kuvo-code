// Mark All as Read (PROTOCOL.md, "What's been read"): everything new on this box read at once, as
// a client asks for it (a phone's Inbox, a Mac's sidebar): each conversation, on the engine and
// the coding agents' bridge, read up to where it ended, and each group chat up to now. What waits on
// your answer isn't read away: it still waits on you.

import { isObject } from "../../shared/json";
import { call, engineGet } from "../engine/client";
import { isArchived } from "../work/tree";
import type { Target } from "../../shared/records";
import type { AnswerPiece, RouteContext } from "../server/context";

export const READ_ALL_ROUTE = "kuvo/sessions/read";

// How far back a place's conversations are listed for it: a few thousand, the latest first.
const PAGES = 15;
// How many reads go at once, and how long each may take (ms).
const AT_ONCE = 8;
const EACH = 10_000;

/** Each of `items` done by `work`, `AT_ONCE` at a time: how many it says it did. */
async function inTurns<Item>(items: Item[], work: (item: Item) => Promise<boolean>, signal?: AbortSignal): Promise<number> {
  let done = 0, next = 0;
  const worker = async () => {
    while (next < items.length && !signal?.aborted) if (await work(items[next++]!)) done++;
  };
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, items.length) }, worker));
  return done;
}

/** Each read's own end: `signal`'s, or its time running out. */
const eachSignal = (signal?: AbortSignal) => (signal ? AbortSignal.any([signal, AbortSignal.timeout(EACH)]) : AbortSignal.timeout(EACH));

/** Every conversation on `target` left unread (subagents' too, so none shows new under its row),
 * read up to where it ended: how many; null where its list couldn't be read at all. */
export async function readAllOn(target: Target, signal?: AbortSignal): Promise<number | null> {
  let read = 0;
  let query: string | null = "limit=200&order=desc";
  for (let pages = 0; pages < PAGES && query && !signal?.aborted; pages++) {
    const page = await engineGet(target, `api/session?${query}`).catch(() => null) as { data?: unknown; cursor?: { next?: unknown } | null } | null;
    if (!page || !Array.isArray(page.data)) return pages === 0 ? null : read;
    const listed = page.data;
    const unread = listed.filter((session): session is { id: string; time: { idle: number } } => {
      if (!isObject(session) || typeof session.id !== "string" || !isObject(session.time)) return false;
      const { idle, viewed } = session.time as { idle?: unknown; viewed?: unknown };
      return typeof idle === "number" && idle > (typeof viewed === "number" ? viewed : 0) && !isArchived(session as never);
    });
    read += await inTurns(unread, session =>
      call(target, "POST", `/api/session/${encodeURIComponent(session.id)}/view`, { idle: session.time.idle }, eachSignal(signal)).then(() => true, () => false), signal);
    const next = page.cursor?.next;
    query = listed.length === 200 && typeof next === "string" ? `limit=200&cursor=${encodeURIComponent(next)}` : null;
  }
  return read;
}

/** Every group chat on the bridge with something new, read up to now: how many; null where its
 * list couldn't be read. */
export async function readGroups(bridge: Target, signal?: AbortSignal): Promise<number | null> {
  const authorization = `Basic ${Buffer.from(`opencode:${bridge.password}`).toString("base64")}`;
  const listed = await fetch(`http://127.0.0.1:${bridge.port}/api/kuvo/link/groups`, { headers: { authorization }, signal: eachSignal(signal) })
    .then(response => response.ok ? response.json() : null).catch(() => null) as { groups?: unknown } | null;
  if (!isObject(listed) || !Array.isArray(listed.groups)) return null;
  const unread = listed.groups.filter((group): group is { id: string } => isObject(group) && typeof group.id === "string" && group.unread === true);
  // (As a client looks at one, through the bridge's own route for it.)
  return inTurns(unread, group => fetch(`http://127.0.0.1:${bridge.port}/api/kuvo/link/groups/${encodeURIComponent(group.id)}/viewed`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: "{}",
    signal: eachSignal(signal),
  }).then(response => response.ok, () => false), signal);
}

// `POST kuvo/sessions/read`: everything new here read; answers `{"read"}`, how many were, or 503
// where nothing here could be read (its engine and its bridge both down).
export async function* readAllRoute({ request, readEngine, bridge, signal, json }: RouteContext): AsyncGenerator<AnswerPiece> {
  if (request.method.toUpperCase() !== "POST") return yield* json(405, {});
  let engine: Target | null = null;
  try { engine = readEngine(); } catch {}
  const agents = bridge();
  const counts = await Promise.all([
    engine ? readAllOn(engine, signal) : null,
    agents ? readAllOn(agents, signal) : null,
    agents ? readGroups(agents, signal) : null,
  ]);
  if (counts.every(count => count === null)) return yield* json(503, { message: "Nothing here could be read just now. Try again in a moment." });
  return yield* json(200, { read: counts.reduce<number>((sum, count) => sum + (count ?? 0), 0) });
}

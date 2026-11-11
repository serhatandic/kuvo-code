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

/** Every conversation on `target` left unread (subagents' too, so none shows new under its row),
 * read up to where it ended: how many. */
export async function readAllOn(target: Target, signal?: AbortSignal): Promise<number> {
  let read = 0;
  let query: string | null = "limit=200&order=desc";
  for (let pages = 0; pages < PAGES && query && !signal?.aborted; pages++) {
    const page = await engineGet(target, `api/session?${query}`).catch(() => null) as { data?: unknown; cursor?: { next?: unknown } | null } | null;
    const listed = Array.isArray(page?.data) ? page.data : [];
    for (const session of listed) {
      if (!isObject(session) || typeof session.id !== "string" || !isObject(session.time)) continue;
      const { idle, viewed } = session.time as { idle?: unknown; viewed?: unknown };
      if (typeof idle !== "number" || idle <= (typeof viewed === "number" ? viewed : 0) || isArchived(session as never)) continue;
      if (await call(target, "POST", `/api/session/${encodeURIComponent(session.id)}/view`, { idle }, signal).then(() => true, () => false)) read++;
    }
    const next = page?.cursor?.next;
    query = listed.length === 200 && typeof next === "string" ? `limit=200&cursor=${encodeURIComponent(next)}` : null;
  }
  return read;
}

/** Every group chat on the bridge with something new, read up to now: how many. */
async function readGroups(bridge: Target, signal?: AbortSignal): Promise<number> {
  const listed = await fetch(`http://127.0.0.1:${bridge.port}/api/kuvo/link/groups`, {
    headers: { authorization: `Basic ${Buffer.from(`opencode:${bridge.password}`).toString("base64")}` },
    signal,
  }).then(response => response.ok ? response.json() : null).catch(() => null) as { groups?: unknown } | unknown[] | null;
  const groups = Array.isArray(listed) ? listed : isObject(listed) && Array.isArray(listed.groups) ? listed.groups : [];
  let read = 0;
  for (const group of groups) {
    if (!isObject(group) || typeof group.id !== "string" || group.unread !== true) continue;
    // (As a client looks at one, through the bridge's own route for it.)
    const looked = await fetch(`http://127.0.0.1:${bridge.port}/api/kuvo/link/groups/${encodeURIComponent(group.id)}/viewed`, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`opencode:${bridge.password}`).toString("base64")}`, "content-type": "application/json" },
      body: "{}",
      signal,
    }).then(response => response.ok, () => false);
    if (looked) read++;
  }
  return read;
}

// `POST kuvo/sessions/read`: everything new here read; answers `{"read"}`, how many were.
export async function* readAllRoute({ request, readEngine, bridge, signal, json }: RouteContext): AsyncGenerator<AnswerPiece> {
  if (request.method.toUpperCase() !== "POST") return yield* json(405, {});
  let engine: Target | null = null;
  try { engine = readEngine(); } catch {}
  const agents = bridge();
  let read = 0;
  if (engine) read += await readAllOn(engine, signal);
  if (agents) read += await readAllOn(agents, signal) + await readGroups(agents, signal);
  return yield* json(200, { read });
}

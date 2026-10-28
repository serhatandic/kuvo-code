// A box's sessions and their conversations read whole, page after page, as the engine (and the
// coding agents' bridge, in the same shape) pages them: what carrying one on and searching them read.

import type { Target } from "../../shared/records";
import { engineGet } from "./client";
import type { EngineSession } from "./sessions";

/** A message of a conversation's, as the engine lists it: read whole, whatever else it has. */
export interface EngineMessage {
  id: string;
  [field: string]: unknown;
}

/** A page of the engine's, whole: what was asked for, and where the next page starts. */
interface Page<T> {
  data?: T[];
  cursor?: { next?: string; previous?: string } | null;
}

/** Every session `target` lists, subagents' too, newest first. */
export async function everySession(target: Target): Promise<EngineSession[]> {
  const all: EngineSession[] = [];
  let page = await engineGet(target, "api/session?limit=100&order=desc") as Page<EngineSession> | null;
  for (let pages = 0; pages < 1000 && page?.data?.length; pages++) {
    all.push(...page.data);
    const cursor = page.cursor?.next;
    if (page.data.length < 100 || !cursor) break;
    page = await engineGet(target, `api/session?limit=100&cursor=${encodeURIComponent(cursor)}`) as Page<EngineSession> | null;
  }
  return all;
}

/** A session's whole conversation, oldest first (a great many messages at most). */
export async function conversationOf(target: Target, id: string): Promise<EngineMessage[]> {
  const route = `api/session/${encodeURIComponent(id)}`;
  let page = await engineGet(target, `${route}/message?limit=200&order=desc`) as Page<EngineMessage> | null;
  let messages = [...(page?.data ?? [])].reverse();
  while ((page?.data?.length ?? 0) >= 200 && messages.length < 20_000) {
    const cursor = page!.cursor?.next ?? page!.cursor?.previous;
    if (!cursor) break;
    page = await engineGet(target, `${route}/message?limit=200&cursor=${encodeURIComponent(cursor)}`) as Page<EngineMessage> | null;
    if (!page?.data?.length) break;
    messages = [...page.data].reverse().concat(messages);
  }
  return messages;
}

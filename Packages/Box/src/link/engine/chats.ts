// Chats, as this box marks them (PROTOCOL.md, "Chats"): a session in its chats folder carries
// `kuvo.chat` in its metadata, naming that folder (as the session names it), so every client draws
// a chat from the session itself, wherever it reads it (the engine's list, an event's reload, a
// search, a move), not from the session's folder. A mark naming another folder than the session's
// own is no mark (one moved out while no box could take it off), so it can't keep one a chat for
// good. The engine makes a session the newest for any write, so the box writes the mark only as a
// session is made, moved or has its metadata written (each of which made it the newest already),
// never on one from before: those go by their folder in every client (`SessionChat`).

import fs from "node:fs";
import { isObject } from "../../shared/json";
import { CHATS, located } from "../home";
import { call, engineGet, type EngineAnswer } from "./client";
import type { EngineSession } from "./sessions";
import type { Target } from "../../shared/records";

// Where the chats folder really is, once it's there (it's made as `kuvo/info` is first asked).
let chatsReal: string | null = null;

/** Whether `directory` is this box's chats folder: as it's named, or the same folder through a
 * link. */
export function isChatsFolder(directory: unknown): boolean {
  if (typeof directory !== "string" || !directory) return false;
  if (directory === CHATS) return true;
  if (!chatsReal && fs.existsSync(CHATS)) chatsReal = located(CHATS);
  return located(directory) === (chatsReal ?? located(CHATS));
}

const folderOf = (session: Partial<EngineSession>): string | undefined => session.location?.directory ?? session.directory;

/** The mark a session in `directory` carries: that folder, in the chats folder; none elsewhere. */
const markFor = (directory: unknown): string | undefined => (isChatsFolder(directory) ? directory as string : undefined);

/** Whether `session` is marked as its folder says: a chat in the chats folder, naming it; no mark
 * elsewhere. */
export const markedRight = (session: Partial<EngineSession>): boolean =>
  session.metadata?.kuvo?.chat === markFor(folderOf(session));

/** `metadata` as a session in `directory` carries it: marked a chat there in the chats folder,
 * unmarked anywhere else; the rest as it was. */
export function chatNotes(metadata: unknown, directory: unknown): Record<string, unknown> {
  const notes = isObject(metadata) ? metadata : {};
  const { chat: _, ...kuvo } = isObject(notes.kuvo) ? notes.kuvo : {};
  const mark = markFor(directory);
  if (mark) return { ...notes, kuvo: { ...kuvo, chat: mark } };
  return isObject(notes.kuvo) ? { ...notes, kuvo } : notes;
}

// Sessions being marked now, by place and ID, and whether another event came for one meanwhile:
// it's marked again once this one's done, from what it is then.
const marking = new Map<string, boolean>();

/** Session `id` on `target` (the engine, or the coding agents' bridge) marked as its folder says:
 * read just before it's written, so what a client wrote before stays, and only written when its mark
 * is wrong. Whether it was written. (Their API writes metadata whole, with nothing to say "only if
 * unchanged": a client's write landing between the read and the write is lost, as with the box's
 * other writers of a session's metadata; #581 serializes them.) */
export async function markChat(target: Target, id: unknown, signal?: AbortSignal): Promise<boolean> {
  if (typeof id !== "string" || !id) return false;
  const key = `${target.port}:${id}`;
  if (marking.has(key)) {
    marking.set(key, true);
    return false;
  }
  marking.set(key, false);
  let written = false;
  try {
    do {
      marking.set(key, false);
      const session = (await engineGet(target, `api/session/${encodeURIComponent(id)}`) as EngineAnswer<EngineSession> | null)?.data;
      if (!session?.id || markedRight(session)) continue;
      await call(target, "PATCH", `/api/session/${encodeURIComponent(id)}`, { metadata: chatNotes(session.metadata, folderOf(session)) }, signal);
      written = true;
    } while (marking.get(key) && !signal?.aborted);
  } finally {
    marking.delete(key);
  }
  return written;
}

/** What an event says of the session it's about, as far as it says it: the engine's
 * `session.created` names its folder and metadata, the bridge's carries the session whole. */
function sessionIn(data: unknown): Partial<EngineSession> | null {
  if (!isObject(data)) return null;
  const whole = isObject(data.session) ? data.session : data;
  return isObject(whole.location) && typeof whole.location.directory === "string" ? whole as Partial<EngineSession> : null;
}

/** The session an event of `type` is about, marked as its folder says where it may have changed:
 * one made (where the event shows it's right already, nothing's read), moved, or whose metadata a
 * client wrote whole (without the mark, say). */
export function markChatOn(target: Target, type: string, data: unknown, signal?: AbortSignal): Promise<boolean> | null {
  if (type !== "session.created" && type !== "session.moved" && type !== "session.metadata.updated") return null;
  const id = isObject(data) ? data.sessionID ?? (isObject(data.info) ? data.info.id : undefined) : undefined;
  const said = type === "session.created" ? sessionIn(data) : null;
  if (said && markedRight(said)) return null;
  return markChat(target, id, signal);
}

// Full Access's conversations, for the sandbox's launcher (fence/files.ts): an empty file named for
// each session in Full Access here now (its subagents' too, each named by the engine as its
// commands run), in the sandbox's own folder, which only the box writes and no command can. Their
// commands, and a coding agent's own program in them, run as yours, outside the sandbox. Kept as
// each run starts (before any command of it runs), as a conversation's approval is changed, and
// as the box follows its engine again (those at work then).

import fs from "node:fs";
import path from "node:path";
import { RUN } from "../home";
import { conversationOf, inFullAccess, type Conversation } from "./reviewing";
import type { Target } from "../../shared/records";

export const FULL_ACCESS_FOLDER = path.join(RUN, "fence", "full");

const named = (session: string) => /^ses_[A-Za-z0-9_]+$/.test(session);

/** `session` marked as in Full Access here, or not: with the conversation it's in (`root`, its own
 * for a conversation; a subagent's, its conversation's), which the file names, so a change of the
 * conversation's approval reaches its subagents' marks too (`markConversation`). */
export function markFullAccess(session: string, on: boolean, root = session, folder = FULL_ACCESS_FOLDER): void {
  if (!named(session)) return;
  const file = path.join(folder, session);
  try {
    if (!on) return fs.rmSync(file, { force: true });
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, named(root) ? root : session, { mode: 0o600 });
  } catch {}
}

/** Whether `session` is marked as in Full Access here: what the box last knew of it, also after it
 * started again while its engine doesn't answer. */
export const markedFullAccess = (session: string, folder = FULL_ACCESS_FOLDER): boolean => named(session) && fs.existsSync(path.join(folder, session));

/** A conversation's approval changed: its mark, and its subagents' (those marked with it), as it is
 * now. A subagent gets its mark again as its next run starts, where it's on. */
export function markConversation(root: string, on: boolean, folder = FULL_ACCESS_FOLDER): void {
  markFullAccess(root, on, root, folder);
  if (on) return;
  let names: string[] = [];
  try { names = fs.readdirSync(folder); } catch {}
  for (const name of names) {
    if (!named(name) || name === root) continue;
    try { if (fs.readFileSync(path.join(folder, name), "utf8") === root) fs.rmSync(path.join(folder, name), { force: true }); } catch {}
  }
}

/** `session` (a subagent's by its conversation) marked as its conversation is now. */
export async function noteFullAccess(session: unknown, found?: Conversation | null): Promise<void> {
  if (typeof session !== "string" || !named(session)) return;
  const at = found === undefined ? await conversationOf(session) : found;
  if (at) markFullAccess(session, inFullAccess(at), at.data.id);
}

/** The sessions at work on `target` now, each marked as its conversation is. */
export async function noteFullAccessAtWork(target: Target, list: (target: Target) => Promise<string[]>): Promise<void> {
  for (const session of await list(target).catch(() => [] as string[])) await noteFullAccess(session).catch(() => {});
}

// Full Access's conversations, for the sandbox's launcher (fence/files.ts): an empty file named for
// each session in Full Access here now (its subagents' too, each named by the engine as its
// commands run), in the sandbox's own folder, which only the box writes and no command can. Their
// commands, and a coding agent's own program in them, run as yours, outside the sandbox. Kept as
// each run starts (before any command of it runs), as a conversation's approval is changed, and
// as the box follows its engine again (those at work then).

import fs from "node:fs";
import path from "node:path";
import { RUN } from "../home";
import { approvalOf } from "./approval";
import { botOfConversation, worksFor } from "./tree";
import { conversationOf, type Conversation } from "./reviewing";
import type { Target } from "../../shared/records";

export const FULL_ACCESS_FOLDER = path.join(RUN, "fence", "full");

const named = (session: string) => /^ses_[A-Za-z0-9_]+$/.test(session);

/** `session` marked as in Full Access here, or not. */
export function markFullAccess(session: string, on: boolean, folder = FULL_ACCESS_FOLDER): void {
  if (!named(session)) return;
  const file = path.join(folder, session);
  try {
    if (!on) return fs.rmSync(file, { force: true });
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, "", { mode: 0o600 });
  } catch {}
}

/** Whether a conversation, where it is, is in Full Access here now. */
export const inFullAccess = (at: Conversation): boolean =>
  approvalOf(at.data, { agents: at.agents, bot: Boolean(botOfConversation(at.data.id) ?? worksFor(at.data)) }).effective === "fullAccess";

/** `session` (a subagent's by its conversation) marked as its conversation is now. */
export async function noteFullAccess(session: unknown, found?: Conversation | null): Promise<void> {
  if (typeof session !== "string" || !named(session)) return;
  const at = found === undefined ? await conversationOf(session) : found;
  if (at) markFullAccess(session, inFullAccess(at));
}

/** The sessions at work on `target` now, each marked as its conversation is. */
export async function noteFullAccessAtWork(target: Target, list: (target: Target) => Promise<string[]>): Promise<void> {
  for (const session of await list(target).catch(() => [] as string[])) await noteFullAccess(session).catch(() => {});
}

// The engine's sessions, as a box tells them apart, and the IDs it gives what it adds to one.

import crypto from "node:crypto";

/** A session as the engine answers for it (`api/session…`), and the coding agents' bridge in the
 * same shape: what a box reads of it. The engine leaves out what a session hasn't got, never null. */
export interface EngineSession {
  id: string;
  /** The session it works for, a subagent's. */
  parentID?: string;
  title?: string;
  agent?: string;
  model?: { id: string; providerID: string; variant?: string };
  location: { directory: string };
  /** Its folder said flat, which this reads too where `location` has none (the engine itself has it
   * only in `location`). */
  directory?: string;
  time: { created: number; updated: number; idle?: number; viewed?: number; archived?: number };
  permissions?: { action: string; resource: string; effect: "allow" | "deny" | "ask" }[];
  /** An undo waiting to be kept: the conversation is back to before this message. */
  revert?: { messageID: string };
  metadata?: SessionNotes;
}

/** Clients' own notes on a session (any JSON object), as far as a box reads them: Kuvo Code's,
 * whatever their values are until they're checked. */
export interface SessionNotes {
  kuvo?: { bot?: unknown; engineFor?: unknown; seat?: unknown; reviewPart?: unknown; archived?: unknown; [more: string]: unknown };
  "kuvo.archived"?: unknown;
  kuvoAgent?: unknown;
  "kuvo.carriedTo"?: unknown;
  [note: string]: unknown;
}

/** A session, as far as telling a hidden run apart reads it. */
type SessionMetadata = Pick<EngineSession, "metadata">;

// Kept out of sight, as the Mac keeps them: an engine run a coding agents' session started (Auto on
// one of the engine's models), whose news the agents' bridge tells as its session's; a bot's seat
// in a group chat, whose chat tells what matters; and a review's part, read in a session of its
// own, which its review shows.
export const isHiddenRun = (session: SessionMetadata | null | undefined) => Boolean(session?.metadata?.kuvo?.engineFor || session?.metadata?.kuvo?.seat || session?.metadata?.kuvo?.reviewPart);

// A message ID that sorts after earlier ones, as the engine's own do.
let lastMessage = { time: 0, counter: 0 };
export function messageID(now = Date.now()) {
  lastMessage = lastMessage.time === now ? { time: now, counter: lastMessage.counter + 1 } : { time: now, counter: 1 };
  const time = ((BigInt(now) * 0x1000n + BigInt(lastMessage.counter)) & 0xFFFFFFFFFFFFn).toString(16).padStart(12, "0");
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  return `msg_${time}${Array.from(crypto.randomBytes(14), byte => alphabet[byte % alphabet.length]).join("")}`;
}


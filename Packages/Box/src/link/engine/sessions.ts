// The engine's sessions, as a box tells them apart, and the IDs it gives what it adds to one.

import crypto from "node:crypto";

/** A session as the engine lists it, as far as a box reads it here. */
interface SessionMetadata {
  metadata?: { kuvo?: { engineFor?: unknown; seat?: unknown } } | null;
}

// Kept out of sight, as the Mac keeps them: an engine run a coding agents' session started (Auto on
// one of the engine's models), whose news the agents' bridge tells as its session's; and a bot's
// seat in a group chat, whose chat tells what matters.
export const isHiddenRun = (session: SessionMetadata | null | undefined) => Boolean(session?.metadata?.kuvo?.engineFor || session?.metadata?.kuvo?.seat);

// A message ID that sorts after earlier ones, as the engine's own do.
let lastMessage = { time: 0, counter: 0 };
export function messageID(now = Date.now()) {
  lastMessage = lastMessage.time === now ? { time: now, counter: lastMessage.counter + 1 } : { time: now, counter: 1 };
  const time = ((BigInt(now) * 0x1000n + BigInt(lastMessage.counter)) & 0xFFFFFFFFFFFFn).toString(16).padStart(12, "0");
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  return `msg_${time}${Array.from(crypto.randomBytes(14), byte => alphabet[byte % alphabet.length]).join("")}`;
}

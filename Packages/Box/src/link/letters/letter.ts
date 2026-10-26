// Letters between boxes (PROTOCOL.md, "Peers")
// An agent's message to one on another box (left in `run/outbox/sending` by kuvo-browser.js) goes to
// that box by mail, until it says it has it; one that comes here is checked, delivered once, and
// with `wait`, answered by a letter back. Here: where they wait, their limits, and how one reaches
// its conversation.

import path from "node:path";
import type { Target } from "../../shared/records";
import { RUN } from "../home";

/** A session as the engine (or the agents' bridge) answers for it, as far as a letter's checks read it. */
export interface PlacedSession {
  parentID?: string;
  metadata?: { kuvo?: Record<string, unknown>; [name: string]: unknown } | null;
  time?: { archived?: number; [name: string]: unknown };
  [field: string]: unknown;
}

/** Where a session runs here, and what it is (`placeOfSession`). */
export interface SessionPlace {
  target: Target;
  data: PlacedSession;
}

export const OUTBOX = path.join(RUN, "outbox");
export const SENDING = path.join(OUTBOX, "sending");
export const LETTERS_SEEN = path.join(RUN, "letters-seen.json");

// A letter older than a day isn't delivered; one is remembered two days (no doubles, no replays).
export const LETTER_LIFE = 86_400_000;
export const LETTER_MEMORY = 2 * 86_400_000;
const LETTER_TEXT = 32_000;
// At most `most` UTF-16 units of `text`, never half a character.
export const cutText = (text: unknown, most = LETTER_TEXT): string => {
  const words = String(text ?? "");
  if (words.length <= most) return words;
  return words.slice(0, /[\uDC00-\uDFFF]/.test(words[most]) ? most - 1 : most);
};

export const LETTER_ID = /^[A-Za-z0-9_-]{6,80}$/;

// What the receiving agent reads, as the Mac and kuvo-browser.js word it (AgentMail.compose).
export const composeLetter = (name: string, session: string, words: string, waits: boolean): string =>
  `[Message from ${name} · ${session}] (${waits ? "They're waiting for your reply: just answer, in your words." : session === "unknown" ? "It can't be answered: who sent it isn't known." : `To answer, use send_message to ${session}.`})\n\n${words}`;

// A session here, where it runs: the engine's or the coding agents' bridge's, by asking each, and
// what it is. Null when each says there's no such session; it throws when one can't be asked (try
// again later).
export async function placeOfSession(session: string, targets: Target[]): Promise<SessionPlace | null> {
  if (!targets.length) throw new Error("Its engine isn't running.");
  let unsure: unknown = null;
  for (const target of targets) {
    try {
      const response = await fetch(`http://127.0.0.1:${target.port}/api/session/${encodeURIComponent(session)}`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${target.password}`).toString("base64")}` }, signal: AbortSignal.timeout(10_000) });
      if (response.ok) return { target, data: (await (response.json() as Promise<{ data?: PlacedSession } | null>).catch(() => null))?.data ?? {} };
      if (response.status !== 404) unsure = new Error(`It answered ${response.status}.`);
    } catch (error) {
      unsure = error;
    }
  }
  if (unsure) throw unsure;
  return null;
}

// When each letter was last sent, by id: one goes again each minute until its box says it has it.
export const letterTries = new Map<string, number>();
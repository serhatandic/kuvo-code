// Letters between boxes (PROTOCOL.md, "Peers")
// An agent's message to one on another box (left in `run/outbox/sending` by kuvo-browser.js) goes to
// that box by mail, until it says it has it; one that comes here is checked, delivered once, and
// with `wait`, answered by a letter back. Here: where they wait, their limits, and how one reaches
// its conversation.

import path from "node:path";
import type { Target } from "../../shared/records";
import type { EngineSession } from "../engine/sessions";
import { RUN } from "../home";

/** Where a session runs here, and what it is (`placeOfSession`): the session as the engine (or the
 * agents' bridge) answers for it, or nothing of it (`{}`) when their answer had none. */
export interface SessionPlace {
  target: Target;
  data: Partial<EngineSession>;
}

export const OUTBOX = path.join(RUN, "outbox");
export const SENDING = path.join(OUTBOX, "sending");
export const LETTERS_SEEN = path.join(RUN, "letters-seen.json");

// A letter older than a day isn't delivered; one is remembered two days (no doubles, no replays).
export const LETTER_LIFE = 86_400_000;
export const LETTER_MEMORY = 2 * 86_400_000;
// A note, the box's own word, is sealed anew each time it's sent, and kept until its conversation
// has it: this long at most, and its id remembered as long, so it's never delivered twice.
export const NOTE_MEMORY = 30 * 86_400_000;
const LETTER_TEXT = 32_000;
// At most `most` UTF-16 units of `text`, never half a character.
export const cutText = (text: unknown, most = LETTER_TEXT): string => {
  const words = String(text ?? "");
  if (words.length <= most) return words;
  return words.slice(0, /[\uDC00-\uDFFF]/.test(words[most]) ? most - 1 : most);
};

export const LETTER_ID = /^[A-Za-z0-9_-]{6,80}$/;

// What the receiving agent reads, as the Mac and kuvo-browser.js word it (AgentMail.compose). A
// session's task from a starter that hears it finish (`finishHeard`): its last reply is its report,
// so it isn't sent again as a message too.
export const composeLetter = (name: string, session: string, words: string, waits: boolean, finishHeard = false): string =>
  `[Message from ${name} · ${session}] (${waits ? "They're waiting for your reply: just answer, in your words." : session === "unknown" ? "It can't be answered: who sent it isn't known." : finishHeard ? `They get your last reply when you finish: end with your report there, not in a message. Use send_message to ${session} only to ask something or say how it's going.` : `To answer, use send_message to ${session}.`})\n\n${words}`;

// What a letter's sender hears when the conversation it wrote to is stopped: the box keeps it there.
export const pausedNote = (name?: string): string =>
  `${name ? `${name} is stopped: the user paused its conversation.` : "That conversation is stopped: the user paused it."} Your message waits there and goes once they resume it; its answer, if it writes one, comes to you as a message.`;

// A session here, where it runs: the engine's or the coding agents' bridge's, by asking each, and
// what it is. Null when each says there's no such session; it throws when one can't be asked (try
// again later).
export async function placeOfSession(session: string, targets: Target[], timeout = 10_000): Promise<SessionPlace | null> {
  if (!targets.length) throw new Error("Its engine isn't running.");
  let unsure: unknown = null;
  for (const target of targets) {
    try {
      const response = await fetch(`http://127.0.0.1:${target.port}/api/session/${encodeURIComponent(session)}`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${target.password}`).toString("base64")}` }, signal: AbortSignal.timeout(timeout) });
      // (As the engine and the agents' bridge answer it: a session they have, whole.)
      if (response.ok) return { target, data: (await (response.json() as Promise<{ data?: EngineSession } | null>).catch(() => null))?.data ?? {} };
      if (response.status !== 404) unsure = new Error(`It answered ${response.status}.`);
    } catch (error) {
      // (One that answered late, or wrongly, says more than one where nothing listens.)
      if (!unsure || isRefused(unsure)) unsure = error;
    }
  }
  if (unsure) throw unsure;
  return null;
}

// How long each try of `placeOfSessionPatiently` waits for an answer from each of the engine and
// the agents' bridge: a busy computer's engine (a load of 150 to 200) can take longer than the
// first, and a client waits on it (a message being sent).
export const PLACE_TRIES = [10_000, 20_000];

// Whether `error` is a connection refused: nothing listens where the engine's record says, so it
// isn't running (it stopped, or crashed and its record outlived it), rather than busy. (Node says
// ECONNREFUSED, under the error's cause; Bun, ConnectionRefused.)
export const isRefused = (error: unknown): boolean => {
  const said = error as { code?: unknown; cause?: { code?: unknown } } | null;
  return [said?.code, said?.cause?.code].some(code => code === "ECONNREFUSED" || code === "ConnectionRefused");
};

// `placeOfSession`, for a client waiting on it: an engine that doesn't answer in time is asked
// again, longer, rather than taken for one that isn't running (#443). It throws as that does once
// every try was unsure, or at once where nothing listens (`isRefused`).
export async function placeOfSessionPatiently(session: string, targets: Target[]): Promise<SessionPlace | null> {
  let unsure: unknown = null;
  for (const timeout of PLACE_TRIES) {
    try {
      return await placeOfSession(session, targets, timeout);
    } catch (error) {
      unsure = error;
      if (isRefused(error)) break;
    }
  }
  throw unsure;
}

// When each letter was last sent, by id: one goes again each minute until its box says it has it.
export const letterTries = new Map<string, number>();
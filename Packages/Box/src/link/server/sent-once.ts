// A message sent again under the same id goes to its conversation once (#144). A phone whose link
// drops before a message's answer comes back can't tell whether it arrived, so it sends it again
// under the same id (PROTOCOL.md, "Sending again"): one still on its way here waits for the first
// and answers as it did; one that went answers as it did then, without the conversation (or the
// files it brought) being asked a second time. One that didn't go (the engine refused it, or
// wasn't there) is tried again. Kept in memory, an hour: after this box starts again the engine,
// which takes a message once by its id, is what's left to catch a repeat.

import type { AnswerPiece } from "./context";

export type SentAnswer = { status: number; headers: Record<string, string>; body: Buffer };

// What a message says when the engine here runs but is too busy to take it in time (504, `busy`):
// it isn't down, and it can be sent again in a moment (#443).
export const BUSY = "This computer is busy: its engine didn't answer in time. Try again in a moment.";

// How long a message added to what waits (`queue/add`) may take to reach its conversation, as the
// engine takes it: a busy engine has it late, and has it then (#443). (An object, for tests to make
// it shorter.)
export const SENDING_PATIENCE = { ms: 120_000 };

// A route's answer, whole (a message's is small).
export async function collected(pieces: AsyncIterable<AnswerPiece>): Promise<SentAnswer> {
  const answer: SentAnswer = { status: 200, headers: {}, body: Buffer.alloc(0) };
  const body: Buffer[] = [];
  for await (const piece of pieces) {
    if ("head" in piece) Object.assign(answer, { status: piece.head.status, headers: piece.head.headers });
    else body.push(piece.body);
  }
  return { ...answer, body: Buffer.concat(body) };
}

// `answer` as a route answers it.
export function* answering(answer: SentAnswer): Generator<AnswerPiece> {
  yield { head: { status: answer.status, headers: answer.headers } };
  if (answer.body.length) yield { body: answer.body };
}

const KEPT_MS = 60 * 60 * 1000;
const AT_MOST = 1000;

const sent = new Map<string, { answer: Promise<SentAnswer>; went?: number }>();

const wentOK = (answer: SentAnswer | null): answer is SentAnswer => answer !== null && answer.status >= 200 && answer.status < 300;

// What a message's id is under, for one conversation: its id in the body, or null for one without.
export function sentKey(place: string, session: string, body: Buffer | undefined): string | null {
  let id: unknown;
  try { id = JSON.parse(Buffer.from(body ?? "").toString("utf8"))?.id; } catch { return null; }
  return typeof id === "string" && id.length > 0 && id.length <= 200 ? `${place}\n${session}\n${id}` : null;
}

// The answer to the message under `key`: the first send's, or `send`'s now if none went.
export async function sentOnce(key: string, send: () => Promise<SentAnswer>, now: () => number = Date.now): Promise<SentAnswer> {
  for (;;) {
    forgetOld(now());
    const earlier = sent.get(key);
    if (!earlier) break;
    const answer = await earlier.answer.catch(() => null);
    if (wentOK(answer)) return answer;
    // It didn't go: forgotten (by whichever repeat gets here first), and tried again.
    if (sent.get(key) === earlier) sent.delete(key);
  }
  const entry: { answer: Promise<SentAnswer>; went?: number } = { answer: send() };
  sent.set(key, entry);
  try {
    const answer = await entry.answer;
    if (wentOK(answer)) entry.went = now();
    else if (sent.get(key) === entry) sent.delete(key);
    return answer;
  } catch (error) {
    if (sent.get(key) === entry) sent.delete(key);
    throw error;
  }
}

// A message taken away (from what waits on the box, or the engine's inbox): sent again under its
// id (Undo), it goes again.
export function forgetSent(session: string, id: string) {
  for (const place of ["engine", "agents", "queue"]) sent.delete(`${place}\n${session}\n${id}`);
}

// Nothing remembered, as when the box starts (for tests that start one again in the same process).
export function forgetEverythingSent() {
  sent.clear();
}

// Ones that went more than an hour ago, and the oldest past the most kept.
function forgetOld(at: number) {
  for (const [key, entry] of sent) if (entry.went !== undefined && at - entry.went > KEPT_MS) sent.delete(key);
  if (sent.size < AT_MOST) return;
  for (const [key, entry] of sent) {
    if (sent.size < AT_MOST) break;
    if (entry.went !== undefined) sent.delete(key);
  }
}

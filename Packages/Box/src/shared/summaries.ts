// A summary you ask for (`/compact`, or a lead's compact_session) runs one of two ways, and only the
// first is a turn of its own, with nothing done to tell of. At rest: what came before it had ended,
// and it ends with an `idle` of its own. During a run on the engine: it's taken at a step of that
// run, and the `idle` after it is the end of that run's real work. Conversations here are newest
// first, as a client's `order=desc` page gives them. How it went is the row's `status`: the engine's
// `idle` and event say `succeeded` even for one that failed.

export interface ConversationRow {
  type?: unknown;
  reason?: unknown;
  status?: unknown;
  outcome?: unknown;
  error?: { message?: unknown } | unknown;
  time?: unknown;
}

const asRows = (messages: unknown) => (Array.isArray(messages) ? messages as ConversationRow[] : []);
/** What's written between turns: notes, a model or mode picked, a command you ran. */
const between = new Set<unknown>(["synthetic", "system", "model-switched", "agent-switched", "shell"]);
const asked = (row: ConversationRow | undefined) => row?.type === "compaction" && row.reason === "manual";

/** Whether the summary at `index` ran on its own: nothing before it was still going. */
function onItsOwn(rows: ConversationRow[], index: number): boolean {
  for (let at = index + 1; at < rows.length; at++) {
    if (between.has(rows[at]?.type)) continue;
    return rows[at]?.type === "idle";
  }
  return true;
}

/** The summary a session did last, if that's all it did since its last turn. */
export function summaryRowAtEnd(messages: unknown): ConversationRow | null {
  const rows = asRows(messages);
  let at = 0;
  // Past what's been written since (a message waiting its turn, a note), and its end.
  while (rows[at]?.type === "user" || between.has(rows[at]?.type)) at++;
  while (rows[at]?.type === "idle") at++;
  while (between.has(rows[at]?.type)) at++;
  const row = rows[at];
  if (!asked(row) || typeof row?.status !== "string") return null;
  return onItsOwn(rows, at) ? row : null;
}

/** How that summary went, if that's what a session did last. */
export const summaryAtEnd = (messages: unknown): string | null => summaryRowAtEnd(messages)?.status as string ?? null;

/** A conversation without the summaries that ran on their own, nor their ends: its turns of work. */
export function pastSummaries<Row extends ConversationRow>(messages: Row[]): Row[] {
  const work: Row[] = [];
  messages.forEach((row, at) => {
    if (!asked(row) || !onItsOwn(messages, at)) {
      work.push(row);
      return;
    }
    // Its end is the newest `idle` just above it, past any notes.
    let end = work.length - 1;
    while (end >= 0 && between.has(work[end]?.type)) end--;
    if (work[end]?.type === "idle") work.splice(end, 1);
  });
  return work;
}

/**
 * How a session's work went: its own word, unless a summary came after that work, whose run changed
 * it. (A run that died without writing an end has only its session's word.)
 */
export function workOutcome(messages: unknown, outcome: unknown): unknown {
  const rows = asRows(messages);
  const work = pastSummaries(rows);
  return work.length < rows.length ? work.find(row => row?.type === "idle")?.outcome ?? outcome : outcome;
}

/** What's part of a turn: what began it, and what its agent said. */
export const ofTurn = (message: { type?: unknown }) => message.type === "user" || message.type === "synthetic" || message.type === "assistant";

/**
 * Where a session's latest turn lies in its messages, newest first (read as it runs too, not ended
 * yet): from `from` up to, not including, `before` (-1 for to the end of what was read).
 */
export function turnIn(messages: { type?: unknown }[]): { from: number; before: number } {
  // (Commands you ran after it, above where it ended, are no part of it.)
  const lastEnd = messages.findIndex(message => message.type === "idle");
  const from = lastEnd >= 0 && !messages.slice(0, lastEnd).some(ofTurn) ? lastEnd + 1 : 0;
  return { from, before: messages.findIndex((message, index) => index >= from && message.type === "idle") };
}

/** A session's latest turn of work, newest first, past the summaries asked for after it. */
export function lastTurn<Row extends ConversationRow>(messages: unknown): Row[] {
  const work = pastSummaries(asRows(messages) as Row[]);
  const { from, before } = turnIn(work);
  return work.slice(from, before < 0 ? undefined : before);
}

/** Where a session's last turn of work ended. */
export const lastTurnEnd = (messages: unknown): ConversationRow | undefined =>
  pastSummaries(asRows(messages)).find(row => row?.type === "idle");

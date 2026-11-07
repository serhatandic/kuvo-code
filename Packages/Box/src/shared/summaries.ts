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
  time?: { created?: number };
}

const asRows = (messages: unknown) => (Array.isArray(messages) ? messages as ConversationRow[] : []);
/** What's written between turns: notes, and a model or mode picked. */
const between = new Set<unknown>(["synthetic", "system", "model-switched", "agent-switched"]);
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
  const at = rows.findIndex(row => row?.type !== "idle");
  if (at < 0 || !asked(rows[at]) || typeof rows[at].status !== "string") return null;
  return onItsOwn(rows, at) ? rows[at] : null;
}

/** How that summary went, if that's what a session did last. */
export const summaryAtEnd = (messages: unknown): string | null => summaryRowAtEnd(messages)?.status as string ?? null;

/** Where a session's last turn of work ended, past any summaries that ran on their own after it. */
export function lastTurnEnd(messages: unknown): ConversationRow | undefined {
  const rows = asRows(messages);
  for (let at = 0; at < rows.length; at++) {
    if (rows[at]?.type !== "idle") continue;
    if (!asked(rows[at + 1]) || !onItsOwn(rows, at + 1)) return rows[at];
    at++;
  }
  return undefined;
}

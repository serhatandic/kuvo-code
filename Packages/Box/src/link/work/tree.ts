// A bot's work, as the box finds it (PROTOCOL.md, "Work"): the sessions a conversation started and
// theirs, each marked as it's started (`kuvo.startedBy`, `kuvo.by`, `kuvo.depth`), where each
// stands now, and the bot each works for. Read from the engine and the coding agents' bridge as they
// are, so every client sees the same, with the Mac closed too.

import path from "node:path";
import { isObject } from "../../shared/json";
import { cut } from "../../shared/text";
import { call, engineGet } from "../engine/client";
import { CHATS } from "../home";
import { answersYou, describePermission, projectNameOf, turnFor } from "../notices/news";
import { readTold } from "../notices/told";
import { isHiddenRun } from "../engine/sessions";
import { lastTurn, lastTurnEnd, summaryAtEnd, summaryRowAtEnd, workOutcome } from "../../shared/summaries";
import { listBots } from "../bots/list";
import { asksIn } from "./answers";
import type { Target } from "../../shared/records";
import type { WorkSession, WorksFor } from "../../shared/routes/work";
import type { EngineSession } from "../engine/sessions";

/** A session as the work list reads it: the engine's, with what `kuvo` notes, and where it runs. */
export interface Listed {
  target: Target;
  data: EngineSession & { cost?: number; tokens?: { input?: number; output?: number; reasoning?: number }; outcome?: string };
}

/** The bot a conversation is, by its session: its id and name; null for one that isn't a bot's. */
export function botOfConversation(session: string | null | undefined): WorksFor | null {
  if (!session) return null;
  const bot = listBots().find(each => each.session === session);
  return bot ? { bot: bot.id, name: bot.name } : null;
}

/** The bot a session works for, as it's marked (`kuvo.by`); null for none. */
export function worksFor(data: Partial<EngineSession> | null | undefined): WorksFor | null {
  const by = data?.metadata?.kuvo?.by;
  return isObject(by) && typeof by.bot === "string" && typeof by.name === "string" ? { bot: by.bot, name: by.name } : null;
}

/** Who started a session, as it's marked; null for one started by you. */
export const startedByOf = (data: Partial<EngineSession> | null | undefined): string | null => {
  const by = data?.metadata?.kuvo?.startedBy;
  return typeof by === "string" && by ? by : null;
};

/** How deep a session is under the one that started its line (1 for one a bot started itself). */
export const depthOf = (data: Partial<EngineSession> | null | undefined): number => {
  const depth = data?.metadata?.kuvo?.depth;
  return typeof depth === "number" && depth > 0 ? depth : 0;
};

/** What a session is to hear of the sessions it starts (`kuvo.wake`). */
export const wakesOf = (data: Partial<EngineSession> | null | undefined): string[] => {
  const wake = data?.metadata?.kuvo?.wake;
  return Array.isArray(wake) ? wake.filter((each): each is string => typeof each === "string") : [];
};

/** Whether a session was put away, in any of the ways a client marks it. */
export const isArchived = (data: Partial<EngineSession>) => Boolean(data.time?.archived || data.metadata?.["kuvo.archived"] === true || data.metadata?.kuvo?.archived === true);

/** Every session here that's someone's work (started by another conversation), the latest first,
 * from the engine and the coding agents' bridge; those put away left out, unless `archived` (as
 * limits count them). A page that can't be read ends that one's list, or with `whole`, throws. */
export async function workSessions(targets: Target[], signal?: AbortSignal, { archived = false, whole = false }: { archived?: boolean; whole?: boolean } = {}): Promise<Listed[]> {
  const found: Listed[] = [];
  for (const target of targets) {
    // Page after page (a few thousand at most), so a bot's work further back is still its.
    let query: string | null = "limit=200&order=desc&parentID=null";
    for (let pages = 0; pages < 15 && query && !signal?.aborted; pages++) {
      let page: { data?: unknown; cursor?: { next?: string } | null } | null;
      try {
        page = await engineGet(target, `api/session?${query}`) as typeof page;
      } catch (error) {
        if (whole) throw error;
        break;
      }
      const listed = Array.isArray(page?.data) ? page.data as Listed["data"][] : [];
      for (const data of listed) {
        if (!data?.id || data.parentID || (!archived && isArchived(data)) || !startedByOf(data)) continue;
        found.push({ target, data });
      }
      const next = page?.cursor?.next;
      query = listed.length === 200 && next ? `limit=200&parentID=null&cursor=${encodeURIComponent(next)}` : null;
    }
  }
  return found.sort((a, b) => (b.data.time?.created ?? 0) - (a.data.time?.created ?? 0));
}

/** The sessions under the conversation `root` (those it started, theirs, and so on), from `all`. */
export function under(root: string, all: Listed[]): Listed[] {
  const byID = new Map(all.map(each => [each.data.id, each]));
  const isUnder = (each: Listed): boolean => {
    let above = startedByOf(each.data);
    for (let step = 0; above && step < 20; step++) {
      if (above === root) return true;
      above = startedByOf(byID.get(above)?.data);
    }
    return false;
  };
  return all.filter(isUnder);
}

/** The sessions a bot's at work in: every one marked as its work. */
export const ofBot = (bot: string, all: Listed[]): Listed[] => all.filter(each => worksFor(each.data)?.bot === bot);

/** The sessions at work now, on each target. */
export async function workingNow(targets: Target[], signal?: AbortSignal): Promise<Set<string>> {
  const working = new Set<string>();
  for (const target of targets) {
    const active = await call(target, "GET", "/api/session/active", undefined, signal).catch(() => null);
    for (const id of Array.isArray(active) ? active : isObject(active) ? Object.keys(active) : []) if (typeof id === "string") working.add(id);
  }
  return working;
}

/** What a session (or one of its subagents) asks now, a permission or a question, in words, with
 * the ask's id; null for nothing. */
export async function askingNow(listed: Listed, signal?: AbortSignal): Promise<{ id: string; what: string } | null> {
  const { permissions, questions } = await asksIn(listed.target, listed.data.id, signal);
  if (permissions[0]) return { id: permissions[0].id, what: describePermission(permissions[0]) };
  if (questions[0]) return { id: questions[0].id, what: `Asks: ${questions[0].text}` };
  return null;
}

/** The first lines of what the latest of `messages` (newest first) to say something said, or null. */
function replyIn(messages: unknown): string | null {
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!isObject(message) || message.type !== "assistant" || !Array.isArray(message.content)) continue;
    const text = message.content.filter((part: unknown) => isObject(part) && part.type === "text").map((part: { text?: unknown }) => String(part.text ?? "")).join(" ").replace(/\s+/g, " ").trim();
    if (text) return cut(text, 280);
  }
  return null;
}

/** The first lines of a session's last reply, or null for none. */
export async function lastReplyOf(listed: Listed, signal?: AbortSignal): Promise<string | null> {
  return replyIn(await lastMessages(listed.target, listed.data.id, signal));
}

/**
 * How full a session's context is now, as the app's gauge reads it: what its last step sent and got
 * back. `summarized`: it was summarized since that step, and how much is left shows at its next.
 * Undefined when it hasn't said.
 */
export async function contextOf(listed: Listed, signal?: AbortSignal): Promise<{ used: number } | { summarized: true } | undefined> {
  const page = await call(listed.target, "GET", `/api/session/${encodeURIComponent(listed.data.id)}/message?limit=20&order=desc`, undefined, signal).catch(() => null);
  for (const message of Array.isArray(page) ? page : []) {
    if (!isObject(message)) continue;
    if (message.type === "compaction" && message.status === "completed") return { summarized: true };
    if (message.type !== "assistant" || !isObject(message.tokens)) continue;
    const { input, output, cache } = message.tokens as { input?: number; output?: number; cache?: { read?: number; write?: number } };
    return { used: (input ?? 0) + (cache?.read ?? 0) + (cache?.write ?? 0) + (output ?? 0) };
  }
  return undefined;
}

/** The summary asked for that a session did last, if that's all it did since its last turn. */
export async function summaryRowOf(target: Target, session: string, signal?: AbortSignal) {
  return summaryRowAtEnd(await lastMessages(target, session, signal));
}

const lastMessages = (target: Target, session: string, signal?: AbortSignal) =>
  call(target, "GET", `/api/session/${encodeURIComponent(session)}/message?limit=6&order=desc`, undefined, signal).catch(() => null);

/**
 * How a session's work ended, past a summary asked for after it, which ends a turn of its own: the
 * engine's `outcome` says how that went. What it said before stands.
 */
function outcomeOf(listed: Listed, page: unknown): unknown {
  return workOutcome(page, listed.data.outcome);
}

/**
 * A session that did nothing but summarize stays read, if it was read before: a summary leaves its
 * idle time newer than when it was last looked at, on the engine as on the bridge. One with news
 * from before it stays unread.
 */
export async function keepReadThroughSummary(target: Target, session: string, signal?: AbortSignal): Promise<void> {
  const route = `/api/session/${encodeURIComponent(session)}`;
  const page = await lastMessages(target, session, signal);
  if (summaryAtEnd(page) !== "completed") return;
  const before = (lastTurnEnd(page)?.time as { created?: number } | undefined)?.created;
  const listed = await call(target, "GET", route, undefined, signal).catch(() => null) as { time?: { viewed?: number; idle?: number } } | null;
  if (before === undefined || listed?.time?.idle === undefined || (listed.time.viewed ?? 0) < before) return;
  // (The engine takes which end you saw, and refuses a look that doesn't say.)
  await call(target, "POST", `${route}/view`, { idle: listed.time.idle }, signal).catch(() => {});
}

/**
 * READ_RULE: a session another conversation started and leads (a bot's work, or one whose starter
 * hears when it finishes: `kuvo.by`, `kuvo.wake`) is that conversation's work, which it hears of
 * itself. So once its turns since you last read it hold nothing that's news to you, they're read,
 * here, and no client shows it new. News to you, as its notification is: a turn that answers you
 * (NOTIFY_RULE: you wrote in it, or answered what it asked you), a turn that failed, and what its
 * agent sent you with notify_user since. While it asks you something, it's left as it is (what
 * it asks still waits on you, with its notification). `session`: its id, or as it's listed.
 */
export async function keepWorkRead(target: Target, session: string | Listed["data"], signal?: AbortSignal): Promise<void> {
  const data = typeof session === "string"
    ? await call(target, "GET", `/api/session/${encodeURIComponent(session)}`, undefined, signal).catch(() => null) as Listed["data"] | null
    : session;
  if (!data?.id || data.parentID || !startedByOf(data) || isHiddenRun(data)) return;
  if (!worksFor(data) && !wakesOf(data).includes("finished")) return;
  const idle = data.time?.idle;
  const viewed = data.time?.viewed ?? 0;
  if (idle === undefined || idle <= viewed) return;
  // Held for news to you at this read: nothing to judge again until it's read.
  if (heldForYou.get(data.id) === viewed) return;
  // (Read after its end, so a turn that ended since is in what's judged, and stays unread here.
  // Past SINCE_PAGES only what's in reach is judged: a session you never opened, long, still clears.)
  const { rows, whole } = await turnsSince(target, data.id, viewed, signal);
  if (signal?.aborted || rows === null) return;
  let judged = 0;
  for (const [index, row] of rows.entries()) {
    if (row.type !== "idle" || (row.time?.created ?? Infinity) <= viewed) continue;
    judged++;
    // (A summary that failed ends as one that succeeded: its own row says so.)
    const failed = row.outcome === "failed" || summaryAtEnd(rows.slice(index)) === "failed";
    // (A turn nothing began, a summary, say, answers no one.)
    const end = rows.findIndex((each, at) => at > index && each.type === "idle");
    const began = rows.slice(index + 1, end < 0 ? undefined : end).some(each => each.type === "user" || each.type === "synthetic");
    if (failed || (began && answersYou(turnFor(rows.slice(index), whole), data))) {
      holdForYou(data.id, viewed);
      return;
    }
  }
  // (Nothing that ended since was found to judge: left as it is.)
  if (!judged) return;
  // (Looked at last, just before it's read: one sent meanwhile isn't cleared with it.)
  if (readTold().some(told => told.by === "agent" && told.notice.data?.session === data.id && told.at > viewed)) return;
  const { permissions, questions, whole: allAsks } = await asksIn(target, data.id, signal);
  if (signal?.aborted || permissions.length || questions.length || !allAsks) return;
  await call(target, "POST", `/api/session/${encodeURIComponent(data.id)}/view`, { idle }, signal).catch(() => {});
}

// The sessions of agents' work left unread for news to you, by the read they were judged at, so
// each turn end after doesn't read them back again (a few hundred at most, the oldest let go).
const heldForYou = new Map<string, number>();
function holdForYou(session: string, viewed: number): void {
  heldForYou.delete(session);
  heldForYou.set(session, viewed);
  if (heldForYou.size > 500) heldForYou.delete(heldForYou.keys().next().value!);
}

// How far back a session's messages are read for the turns that ended since it was read.
const SINCE_PAGES = 20;

/** A session's messages, newest first, back to the end of a turn from before `viewed` (or its
 * first): `whole` once that's in them; null when they can't be read. */
async function turnsSince(target: Target, session: string, viewed: number, signal?: AbortSignal): Promise<{ rows: { type?: string; outcome?: string; time?: { created?: number } }[] | null; whole: boolean }> {
  const rows: { type?: string; outcome?: string; time?: { created?: number } }[] = [];
  let query = "limit=50&order=desc";
  for (let pages = 0; pages < SINCE_PAGES && !signal?.aborted; pages++) {
    const page = await engineGet(target, `api/session/${encodeURIComponent(session)}/message?${query}`).catch(() => null) as { data?: unknown; cursor?: { next?: string; previous?: string } | null } | null;
    if (!page || !Array.isArray(page.data)) return { rows: null, whole: false };
    const read = page.data.filter((row): row is (typeof rows)[number] => isObject(row) && typeof row.type === "string");
    rows.push(...read);
    const next = page.cursor?.next ?? page.cursor?.previous;
    if (!read.length || !next || read.some(row => row.type === "idle" && (row.time?.created ?? Infinity) <= viewed)) return { rows, whole: true };
    query = `limit=100&cursor=${encodeURIComponent(next)}`;
  }
  return { rows, whole: false };
}

/** READ_RULE for what ended while this box wasn't listening: each session of agents' work here
 * left unread, read unless what came since is news to you. */
export async function settleWorkRead(target: Target, signal?: AbortSignal): Promise<void> {
  for (const { data } of await workSessions([target], signal)) {
    if (signal?.aborted) return;
    await keepWorkRead(target, data, signal);
  }
}

const tokensOf = (data: Listed["data"]) => (data.tokens?.input ?? 0) + (data.tokens?.output ?? 0) + (data.tokens?.reasoning ?? 0);

/** A session of a bot's work as clients show it: where it stands now (`working`, what each asks:
 * `asks`), and, with `replies`, its last reply's first lines. */
export async function describeWork(listed: Listed, working: Set<string>, { replies = false, signal }: { replies?: boolean; signal?: AbortSignal } = {}): Promise<WorkSession & { askID?: string }> {
  const { data } = listed;
  const folder = data.location?.directory ?? data.directory ?? "";
  const asking = await askingNow(listed, signal);
  // (With its last reply, read as well: how it ended, past a summary.)
  const read = replies && !working.has(data.id);
  const page = read ? await lastMessages(listed.target, data.id, signal) : null;
  const outcome = read ? outcomeOf(listed, page) : data.outcome;
  const state: WorkSession["state"] = asking ? "asking" : working.has(data.id) ? "working"
    : outcome === "succeeded" ? "finished" : outcome === "failed" ? "failed" : outcome === "interrupted" ? "stopped" : data.time?.idle ? "finished" : "idle";
  // A turn cut short says what it said in that turn, if anything: an earlier turn's reply would
  // read as how it ended.
  const reply = !replies || state === "working" ? null
    : state === "stopped" || state === "failed" ? replyIn(lastTurn(page))
    : read ? replyIn(page) : await lastReplyOf(listed, signal);
  const project = folder === CHATS ? undefined : projectNameOf(folder, data);
  return {
    session: data.id,
    title: data.title || "New Session",
    folder,
    ...(project ? { project } : {}),
    startedBy: startedByOf(data) ?? "",
    depth: depthOf(data) || 1,
    ...(data.model?.id && data.model.providerID ? { model: { id: data.model.id, providerID: data.model.providerID, ...(data.model.variant ? { variant: data.model.variant } : {}) } } : {}),
    ...(data.agent ? { mode: data.agent } : {}),
    state,
    ...(asking ? { asks: asking.what, askID: asking.id } : {}),
    started: data.time?.created ?? 0,
    tokens: tokensOf(data),
    ...(typeof data.cost === "number" && data.cost > 0 ? { cost: data.cost } : {}),
    ...(reply ? { lastReply: reply } : {}),
  };
}

/** A session's place, in words: "in Tidepool", "in the chats". */
export const placeWords = (work: Pick<WorkSession, "project" | "folder">) => (work.project ? `in ${work.project}` : work.folder === CHATS ? "in the chats" : `in ${path.basename(work.folder) || work.folder}`);

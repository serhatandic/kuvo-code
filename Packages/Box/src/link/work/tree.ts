// A bot's work, as the box finds it (PROTOCOL.md, "Work"): the sessions a conversation started and
// theirs, each marked as it's started (`kuvo.startedBy`, `kuvo.by`, `kuvo.depth`), where each
// stands now, and the bot each works for. Read from the engine and the coding agents' bridge as they
// are, so every client sees the same, with the Mac closed too.

import path from "node:path";
import { isObject } from "../../shared/json";
import { cut } from "../../shared/text";
import { call, engineGet } from "../engine/client";
import { CHATS } from "../home";
import { describePermission, projectNameOf } from "../notices/news";
import { lastTurnEnd, summaryAtEnd, summaryRowAtEnd, workOutcome } from "../../shared/summaries";
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

/** The conversations above a session, its starter's starter first and its starter last
 * (`kuvo.line`, copied from its starter's as it starts, so it's known under a lead on another
 * computer though the one between isn't here); one from before lines, its starter. */
export const lineOf = (data: Partial<EngineSession> | null | undefined): string[] => {
  const line = data?.metadata?.kuvo?.line;
  if (Array.isArray(line)) return line.filter((each): each is string => typeof each === "string" && /^ses_[A-Za-z0-9]{1,60}$/.test(each)).slice(-20);
  const by = startedByOf(data);
  return by ? [by] : [];
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
  // (Up its starters here, and its line, for one whose line crosses computers.)
  const isUnder = (each: Listed): boolean => {
    let at: Listed | undefined = each;
    for (let step = 0; at && step < 20; step++) {
      if (lineOf(at.data).includes(root)) return true;
      const above = startedByOf(at.data);
      if (!above) return false;
      at = byID.get(above);
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

/** The first lines of a session's last reply, or null for none. */
export async function lastReplyOf(listed: Listed, signal?: AbortSignal): Promise<string | null> {
  const page = await call(listed.target, "GET", `/api/session/${encodeURIComponent(listed.data.id)}/message?limit=6&order=desc`, undefined, signal).catch(() => null);
  for (const message of Array.isArray(page) ? page : []) {
    if (!isObject(message) || message.type !== "assistant" || !Array.isArray(message.content)) continue;
    const text = message.content.filter((part: unknown) => isObject(part) && part.type === "text").map((part: { text?: unknown }) => String(part.text ?? "")).join(" ").replace(/\s+/g, " ").trim();
    if (text) return cut(text, 280);
  }
  return null;
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

const tokensOf = (data: Listed["data"]) => (data.tokens?.input ?? 0) + (data.tokens?.output ?? 0) + (data.tokens?.reasoning ?? 0);

/** A session of a bot's work as clients show it: where it stands now (`working`, what each asks:
 * `asks`), and, with `replies`, its last reply's first lines. */
export async function describeWork(listed: Listed, working: Set<string>, { replies = false, signal }: { replies?: boolean; signal?: AbortSignal } = {}): Promise<WorkSession & { askID?: string }> {
  const { data } = listed;
  const folder = data.location?.directory ?? data.directory ?? "";
  const asking = await askingNow(listed, signal);
  // (With its last reply, read as well: how it ended, past a summary.)
  const outcome = replies && !working.has(data.id) ? outcomeOf(listed, await call(listed.target, "GET", `/api/session/${encodeURIComponent(data.id)}/message?limit=6&order=desc`, undefined, signal).catch(() => null)) : data.outcome;
  const state: WorkSession["state"] = asking ? "asking" : working.has(data.id) ? "working"
    : outcome === "succeeded" ? "finished" : outcome === "failed" ? "failed" : outcome === "interrupted" ? "stopped" : data.time?.idle ? "finished" : "idle";
  const reply = replies && state !== "working" ? await lastReplyOf(listed, signal) : null;
  const project = folder === CHATS ? undefined : projectNameOf(folder);
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

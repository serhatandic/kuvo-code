// A conversation hears of the sessions it started (PROTOCOL.md, "Work"): as one finishes, fails or
// asks for something, the box writes to it, as a wake-up does, so it never checks on them. Those
// that come close together go as one message, kept in `run/work/wakes.json` until they're sent, so
// none is lost to the box starting again. Each changes its bot's work, for clients to read again.

import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { cut } from "../../shared/text";
import { asked, call } from "../engine/client";
import { messageID } from "../engine/sessions";
import { locked, writePrivate } from "../files";
import { placeOfSession } from "../letters/letter";
import { describeForm, describePermission } from "../notices/news";
import { noteWorkChanged, WORK_FOLDER } from "./changes";
import { lastReplyOf, placeWords, startedByOf, wakesOf, worksFor } from "./tree";
import { projectNameOf } from "../notices/news";
import type { Target } from "../../shared/records";
import type { EngineSession } from "../engine/sessions";
import type { EngineForm, PermissionAsked } from "../notices/news";

export const WORK_WAKES = path.join(WORK_FOLDER, "wakes.json");
const LOCK = path.join(WORK_FOLDER, ".wakes.lock");
/** How long the box gathers what's to tell a conversation before it writes (ms). */
export const GATHER = 4000;

/** What waits to be told a conversation: its lines, whether one is an ask (sent to be read at its
 * next step, not after its turn), and since when (ms). */
interface Waiting {
  lines: string[];
  asks: boolean;
  since: number;
}

/** An event the work watcher reads: a run that ended, a permission or a question asked, an ask
 * answered. */
export interface WorkEvent {
  type: string;
  data?: Partial<PermissionAsked> & { sessionID?: string; form?: EngineForm; requestID?: string };
}

const readWaiting = (file: string): Record<string, Waiting> => {
  try {
    const kept = JSON.parse(fs.readFileSync(file, "utf8"));
    return isObject(kept) ? kept as Record<string, Waiting> : {};
  } catch {
    return {};
  }
};
const changeWaiting = <T>(file: string, change: (waiting: Record<string, Waiting>) => T): T => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return locked(LOCK, () => {
    const waiting = readWaiting(file);
    const value = change(waiting);
    writePrivate(file, JSON.stringify(waiting));
    return value;
  });
};

// How long a run took, in words.
const took = (ms: number) => {
  const minutes = Math.round(ms / 60_000);
  return minutes < 1 ? "under a minute" : minutes < 90 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
};

/** What a conversation is told of one of its sessions, as a line, or null for nothing. */
export async function wakeLine(event: WorkEvent, session: Partial<EngineSession> & { id: string }, target: Target): Promise<string | null> {
  const folder = session.location?.directory ?? session.directory ?? "";
  const project = projectNameOf(folder);
  const named = `"${session.title || "New Session"}" ${placeWords({ project, folder })} (address ${session.id})`;
  switch (event.type) {
    case "session.execution.succeeded": {
      const reply = await lastReplyOf({ target, data: session as never });
      const since = session.time?.created ? `, after ${took(Date.now() - session.time.created)}` : "";
      return `[Session finished] ${named}${since}:\n${reply ? cut(reply, 1200) : "(It ended without a reply.)"}`;
    }
    case "session.execution.failed":
      return `[Session failed] ${named} stopped with an error. Read it with read_conversation, then start it again, try another way, or tell the user.`;
    case "permission.asked": {
      const what = describePermission(event.data as PermissionAsked).replace(/^Wants to /, "asks to ").replace(/\.$/, "");
      return `[Session asks] ${named} ${what} (ask ${event.data?.id}). Answer with answer_ask if it's yours to allow, or tell the user in a line and carry on.`;
    }
    case "form.created": {
      const form = event.data?.form ?? (event.data as unknown as EngineForm);
      return `[Session asks] ${named} asks: ${describeForm(form)} (ask ${form.id}). Answer with answer_ask (answer), or tell the user in a line and carry on.`;
    }
  }
  return null;
}

/** What goes to a conversation, from the lines gathered for it. */
export const wakeText = (lines: string[]) => lines.join("\n\n");

/** What `workWatcher` is given: how long it gathers (ms; a test's short), and its clock. */
export interface WorkWatch {
  gather?: number;
  schedule?: (run: () => Promise<void>, ms: number) => unknown;
  file?: string;
}

/** Follows `source`'s events for the work of bots and of any conversation that started sessions:
 * each one that ends or asks, told to whoever started it (as its `kuvo.wake` says), close ones as
 * one message; each, a change to its bot's work. `targets()`: where conversations here run. */
export function workWatcher(source: Target, targets: () => Target[], { gather = GATHER, schedule = setTimeout, file = WORK_WAKES }: WorkWatch = {}): (event: WorkEvent) => Promise<void> {
  const due = new Set<string>();
  // How many tries in a row each has failed, for the wait before the next.
  const failures = new Map<string, number>();
  const putBack = (starter: string, waiting: Waiting) => changeWaiting(file, all => {
    const now = all[starter];
    all[starter] = { lines: [...waiting.lines, ...(now?.lines ?? [])], asks: waiting.asks || Boolean(now?.asks), since: waiting.since };
  });
  const send = async (starter: string) => {
    due.delete(starter);
    const waiting = changeWaiting(file, all => {
      const one = all[starter];
      delete all[starter];
      return one;
    });
    if (!waiting?.lines.length) return;
    // Gone for sure: nothing to tell. Not to be reached now (the engine starting again): kept, and
    // tried again a little later each time.
    const place = await placeOfSession(starter, targets()).catch(() => undefined);
    if (place === null) return;
    try {
      if (!place) throw new Error("Not reached.");
      await asked(place.target, "POST", `api/session/${encodeURIComponent(starter)}/prompt`, { id: messageID(), text: wakeText(waiting.lines), delivery: waiting.asks ? "steer" : "queue" });
      failures.delete(starter);
    } catch {
      putBack(starter, waiting);
      const tries = (failures.get(starter) ?? 0) + 1;
      failures.set(starter, tries);
      soon(starter, Math.min(300_000, gather * 2 ** tries));
    }
  };
  const soon = (starter: string, after = gather) => {
    if (due.has(starter)) return;
    due.add(starter);
    schedule(() => send(starter).catch(() => {}), after);
  };
  // What a box left waiting as it stopped: sent now.
  for (const starter of Object.keys(readWaiting(file))) soon(starter);
  const sessions = new Map<string, Partial<EngineSession> & { id: string }>();
  const sessionOf = async (id: string) => {
    const data = await call(source, "GET", `/api/session/${encodeURIComponent(id)}`) as (Partial<EngineSession> & { id: string }) | null;
    if (data?.id) sessions.set(id, data);
    return data?.id ? data : null;
  };
  // (What each event set going, for a test to wait on.)
  return event => {
    const id = event.data?.sessionID ?? event.data?.form?.sessionID;
    if (typeof id !== "string" || !["session.execution.succeeded", "session.execution.failed", "permission.asked", "form.created", "permission.replied", "form.replied"].includes(event.type)) return Promise.resolve();
    return (async () => {
      // A subagent's ask is its conversation's.
      let session = await sessionOf(id);
      for (let step = 0; session?.parentID && step < 5; step++) session = await sessionOf(session.parentID);
      if (!session || (session.id !== id && event.type.startsWith("session.execution"))) return;
      const bot = worksFor(session)?.bot;
      if (bot) noteWorkChanged(bot);
      const starter = startedByOf(session);
      const wakes = wakesOf(session);
      const kind = event.type.startsWith("session.execution") ? "finished" : event.type.endsWith(".asked") || event.type === "form.created" ? "asks" : null;
      if (!starter || !kind || !wakes.includes(kind)) return;
      const line = await wakeLine(event, session, source);
      if (!line) return;
      changeWaiting(file, all => {
        const now = all[starter] ?? { lines: [], asks: false, since: Date.now() };
        all[starter] = { lines: [...now.lines, line], asks: now.asks || kind === "asks", since: now.since };
      });
      soon(starter);
    })().catch(() => {});
  };
}

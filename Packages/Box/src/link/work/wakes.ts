// A conversation hears of the sessions it started (PROTOCOL.md, "Work"): as one finishes, fails or
// asks for something, the box writes to it, as a wake-up does, so it never checks on them. Those
// that come close together go as one message, kept in `run/work/wakes.json` until they're sent, so
// none is lost to the box starting again; and what happened while it was down is told as it starts
// (`run/work/told.json` says what was). Each changes its bot's work, for clients to read again.

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
import { asksIn } from "./answers";
import { tellLateAnswers } from "./asks";
import { lastReplyOf, placeWords, startedByOf, wakesOf, workingNow, workSessions, worksFor } from "./tree";
import { projectNameOf } from "../notices/news";
import type { Target } from "../../shared/records";
import type { EngineSession } from "../engine/sessions";
import type { EngineForm, PermissionAsked } from "../notices/news";

export const WORK_WAKES = path.join(WORK_FOLDER, "wakes.json");
/** What each followed session's starter was told (its last reply's message, its asks), and when the
 * box last heard anything: what it missed while it was down is told as it starts again, once. */
export const WORK_TOLD = path.join(WORK_FOLDER, "told.json");
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

/** What `starter` was still to hear of its sessions, dropped (Stop All). */
export function forgetWakes(starter: string, file = WORK_WAKES): void {
  try {
    changeWaiting(file, all => {
      delete all[starter];
    });
  } catch {}
}

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

/** What a starter was told of each of its sessions, and when the box last heard of any. */
interface Told {
  since: number;
  sessions: Record<string, { reply?: string; asks?: string[] }>;
}
const readTold = (file: string): Told | null => {
  try {
    const kept = JSON.parse(fs.readFileSync(file, "utf8"));
    return isObject(kept) && typeof kept.since === "number" ? { since: kept.since, sessions: isObject(kept.sessions) ? kept.sessions as Told["sessions"] : {} } : null;
  } catch {
    return null;
  }
};
const changeTold = (file: string, change: (told: Told) => void) => {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    locked(LOCK + "-told", () => {
      const told = readTold(file) ?? { since: Date.now(), sessions: {} };
      change(told);
      told.since = Math.max(told.since, Date.now());
      // The latest few hundred: older ones have long been told.
      const ids = Object.keys(told.sessions);
      for (const id of ids.slice(0, Math.max(0, ids.length - 400))) delete told.sessions[id];
      writePrivate(file, JSON.stringify(told));
    });
  } catch {}
};

// The id of a session's last reply, or null for none.
async function lastReplyID(target: Target, session: string): Promise<string | null> {
  const page = await call(target, "GET", `/api/session/${encodeURIComponent(session)}/message?limit=6&order=desc`).catch(() => null);
  for (const message of Array.isArray(page) ? page : []) if (isObject(message) && message.type === "assistant" && typeof message.id === "string") return message.id;
  return null;
}

/** What `workWatcher` is given: how long it gathers (ms; a test's short), and its clock. */
export interface WorkWatch {
  gather?: number;
  toldFile?: string;
  schedule?: (run: () => Promise<void>, ms: number) => unknown;
  file?: string;
}

/** Follows `source`'s events for the work of bots and of any conversation that started sessions:
 * each one that ends or asks, told to whoever started it (as its `kuvo.wake` says), close ones as
 * one message; each, a change to its bot's work. `targets()`: where conversations here run. */
export function workWatcher(source: Target, targets: () => Target[], { gather = GATHER, schedule = setTimeout, file = WORK_WAKES, toldFile = WORK_TOLD }: WorkWatch = {}): ((event: WorkEvent) => Promise<void>) & { caughtUp: Promise<void> } {
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
  // A line for `starter`, kept until it's sent, and what it told noted.
  const tell = (starter: string, line: string, asks: boolean) => {
    changeWaiting(file, all => {
      const now = all[starter] ?? { lines: [], asks: false, since: Date.now() };
      all[starter] = { lines: [...now.lines, line], asks: now.asks || asks, since: now.since };
    });
    soon(starter);
  };
  const noteTold = (session: string, note: { reply?: string | null; ask?: string }) => changeTold(toldFile, told => {
    const now = told.sessions[session] ?? {};
    if (note.reply) now.reply = note.reply;
    if (note.ask) now.asks = [...(now.asks ?? []).filter(each => each !== note.ask), note.ask].slice(-20);
    told.sessions[session] = now;
  });
  // What happened while the box was down (its link starting again): each followed session that
  // finished, failed or asked since it last heard of any, and hasn't been told, told now.
  const catchUp = async () => {
    const told = readTold(toldFile);
    if (!told) return changeTold(toldFile, () => {});
    const followed = (await workSessions([source])).filter(each => startedByOf(each.data) && wakesOf(each.data).length && (each.data.time?.updated ?? 0) > told.since);
    const working = await workingNow([source]);
    for (const { data } of followed) {
      const starter = startedByOf(data)!;
      const wakes = wakesOf(data);
      const was = told.sessions[data.id] ?? {};
      if (wakes.includes("asks")) {
        const { permissions, questions } = await asksIn(source, data.id).catch(() => ({ permissions: [], questions: [] }));
        for (const permission of permissions.filter(each => !was.asks?.includes(each.id))) {
          const line = await wakeLine({ type: "permission.asked", data: { id: permission.id, sessionID: data.id, action: permission.action, resources: permission.resources } as WorkEvent["data"] }, data, source);
          if (line) tell(starter, line, true);
          noteTold(data.id, { ask: permission.id });
        }
        for (const question of questions.filter(each => !was.asks?.includes(each.id))) {
          tell(starter, `[Session asks] "${data.title || "New Session"}" (address ${data.id}) asks: ${question.text} (ask ${question.id}). Answer with answer_ask (answer), or tell the user in a line and carry on.`, true);
          noteTold(data.id, { ask: question.id });
        }
      }
      if (wakes.includes("finished") && !working.has(data.id)) {
        const reply = await lastReplyID(source, data.id);
        if (!reply || reply === was.reply) continue;
        const failed = (data as { outcome?: string }).outcome === "failed";
        const line = await wakeLine({ type: failed ? "session.execution.failed" : "session.execution.succeeded", data: { sessionID: data.id } }, data, source);
        if (line) tell(starter, line, false);
        noteTold(data.id, { reply });
      }
    }
    changeTold(toldFile, () => {});
  };
  const caughtUp = Promise.all([catchUp().catch(() => {}), tellLateAnswers(targets).catch(() => {})]).then(() => {});
  // (What each event set going, for a test to wait on.)
  const watch = (event: WorkEvent) => {
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
      tell(starter, line, kind === "asks");
      const ask = event.data?.id ?? event.data?.form?.id;
      noteTold(session.id, kind === "asks" ? { ask: typeof ask === "string" ? ask : undefined } : { reply: await lastReplyID(source, session.id) });
    })().catch(() => {});
  };
  return Object.assign(watch, { caughtUp });
}

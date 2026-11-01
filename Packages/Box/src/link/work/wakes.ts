// A conversation hears of the sessions it started (PROTOCOL.md, "Work"): as one finishes, fails or
// asks for something, the box writes to it, as a wake-up does, so it never checks on them. Those
// that come close together go as one message, kept in `run/work/wakes.json` until they're sent, so
// none is lost to the box starting again; and what happened while it was down is told as it starts
// (`run/work/told.json` says what was). Each changes its bot's work, for clients to read again.

import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { cut } from "../../shared/text";
import { asked, call, peerPlaces } from "../engine/client";
import { sendInto } from "../engine/queue";
import { boxNote } from "../../shared/queues";
import { messageID } from "../engine/sessions";
import { locked, writePrivate } from "../files";
import { LETTER_LIFE, placeOfSession } from "../letters/letter";
import { isPutAway, type PutAwayable } from "../peers/directory";
import { describeForm, describePermission } from "../notices/news";
import { noteWorkChanged, WORK_FOLDER } from "./changes";
import { asksIn } from "./answers";
import { awaitedBy } from "./awaited";
import { tellLateAnswers } from "./asks";
import { lastReplyOf, placeWords, startedByOf, wakesOf, workSessions, worksFor, type Listed } from "./tree";
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

/** What a conversation shows for the lines told it (`wakeLine`'s), in place of them: "“Sign-in”
 * finished", or how many there are. */
export function wakeLineShown(lines: string[]): string {
  if (lines.length !== 1) return `${lines.length} updates from its sessions`;
  const said = /^\[Session (finished|failed|asks)\] "([^"\n]*)"/.exec(lines[0]!);
  if (!said) return "News from a session";
  const what = said[1] === "finished" ? "finished" : said[1] === "failed" ? "stopped with an error" : "asks something";
  return `“${said[2] || "New Session"}” ${what}`;
}

// How often answers given late that couldn't be told yet are tried again.
const LATE_AGAIN = 300_000;
// How soon what happened while the box was down is looked at again, when it couldn't be.
const CATCH_UP_AGAIN = 60_000;
// How often a finish its starter waits on looks whether that wait has ended.
const AWAIT_LOOK = 3_000;
// How many times a catch-up that couldn't read some of the sessions is tried again, before they're
// let go of until the box starts the next time; and on how many starts in a row, before for good.
const CATCH_UP_TRIES = 10;
const UNREAD_STARTS = 3;

// How long what a conversation would hear waits while it's archived.
const ARCHIVED_FOR = 7 * 86_400_000;

/** What a starter was told of each of its sessions (its last reply, its asks, and when it was told
 * it finished: `at`, for when its reply couldn't be read then), and when the box last heard of any:
 * from its engine (`since`), and from each other place they run (`sinces`: the coding agents'
 * bridge), each its own, as each is found at a time of its own. `unread`: the sessions it couldn't
 * read as it last started, and on how many starts in a row. `held`: those whose finish waits for
 * their starter's wait to end, the place they run and since when (looked at as the box starts,
 * whenever they finished). */
interface Told {
  since: number;
  sinces?: Record<string, number>;
  /** Of each session: its last reply told, the asks told, when its finish was told, and its newest
   * message as a failed turn was told (one that failed before it replied ends with no reply). */
  sessions: Record<string, { reply?: string; asks?: string[]; at?: number; turn?: string }>;
  unread?: Record<string, number>;
  held?: Record<string, { from: string; at: number }>;
}
const readTold = (file: string): Told | null => {
  try {
    const kept = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!isObject(kept) || typeof kept.since !== "number") return null;
    const numbers = (value: unknown) => Object.fromEntries(Object.entries(isObject(value) ? value : {}).filter(([, number]) => typeof number === "number")) as Record<string, number>;
    const sinces = numbers(kept.sinces);
    const unread = numbers(kept.unread);
    const held = Object.fromEntries(Object.entries(isObject(kept.held) ? kept.held : {}).filter(([, each]) => isObject(each) && typeof each.from === "string" && typeof each.at === "number")) as Record<string, { from: string; at: number }>;
    return { since: kept.since, ...(Object.keys(sinces).length ? { sinces } : {}), sessions: isObject(kept.sessions) ? kept.sessions as Told["sessions"] : {}, ...(Object.keys(unread).length ? { unread } : {}), ...(Object.keys(held).length ? { held } : {}) };
  } catch {
    return null;
  }
};
// Where the box's own engine's sessions are heard of (`WorkWatch.from`), and its other places.
const ENGINE = "engine";
const OTHERS = ["bridge"];
// When the box last heard of `from`'s sessions (a box from before each had its own: the engine's).
const sinceOf = (told: Told, from: string) => (from === ENGINE ? told.since : told.sinces?.[from] ?? told.since);
// What was told changed; with `from`, the box has heard of everything of its until `until`.
const changeTold = (file: string, change: (told: Told) => void, from: string | null, until: number) => {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    locked(LOCK + "-told", () => {
      const told = readTold(file) ?? { since: until, sessions: {} };
      change(told);
      if (from === ENGINE) {
        // (Each other place keeps the time the engine had, which was theirs too until now.)
        const theirs = Object.fromEntries(OTHERS.map(other => [other, sinceOf(told, other)]));
        told.sinces = { ...theirs, ...told.sinces };
        told.since = Math.max(told.since, until);
      }
      else if (from) told.sinces = { ...told.sinces, [from]: Math.max(sinceOf(told, from), until) };
      // The latest few hundred: older ones have long been told.
      const ids = Object.keys(told.sessions);
      for (const id of ids.slice(0, Math.max(0, ids.length - 400))) delete told.sessions[id];
      writePrivate(file, JSON.stringify(told));
    });
  } catch {}
};

// A session's last reply (its id, and when it was written; null for none), and its newest message
// of any kind (`latest`: a turn that failed before it replied ends with yours, or the end the
// coding agents' bridge notes); it throws when it can't be read.
async function lastReply(target: Target, session: string): Promise<{ id: string | null; at: number | null; latest: string | null }> {
  const page = await call(target, "GET", `/api/session/${encodeURIComponent(session)}/message?limit=6&order=desc`);
  const messages = (Array.isArray(page) ? page : []).filter(message => isObject(message) && typeof message.id === "string");
  const reply = messages.find(message => message.type === "assistant");
  return { id: reply?.id ?? null, at: isObject(reply?.time) && typeof reply.time.created === "number" ? reply.time.created : null, latest: messages[0]?.id ?? null };
}

/** What `workWatcher` is given: how long it gathers (ms; a test's short), and its clock. */
export interface WorkWatch {
  gather?: number;
  toldFile?: string;
  schedule?: (run: () => Promise<void>, ms: number) => unknown;
  /** The time now, as it notes when it told or looked. */
  now?: () => number;
  /** Ends what it keeps doing on its own (trying late answers again): the engine's connection it
   * follows, gone. */
  signal?: AbortSignal;
  file?: string;
  /** Whether the coding agents' bridge runs now (a conversation the engine doesn't know may be its). */
  bridgeRuns?: () => boolean;
  /** Which of the box's places `source` is: its engine (the default), or `bridge`, the coding
   * agents' (each found at a time of its own, so each caught up from when it was last heard). */
  from?: string;
}

/** Follows `source`'s events for the work of bots and of any conversation that started sessions:
 * each one that ends or asks, told to whoever started it (as its `kuvo.wake` says), close ones as
 * one message; each, a change to its bot's work. `targets()`: where conversations here run. */
export function workWatcher(source: Target, targets: () => Target[], { gather = GATHER, schedule = setTimeout, now = Date.now, file = WORK_WAKES, toldFile = WORK_TOLD, bridgeRuns = () => peerPlaces().bridge, signal, from = ENGINE }: WorkWatch = {}): ((event: WorkEvent) => Promise<void>) & { caughtUp: Promise<void> } {
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
    // Gone for sure: nothing to tell. Not to be reached now (the engine starting again, or the coding
    // agents' bridge not running, whose it may be): kept, a day at most, and tried again a little
    // later each time.
    const place = await placeOfSession(starter, targets()).catch(() => undefined);
    if (place === null && (bridgeRuns() || Date.now() - waiting.since > LETTER_LIFE)) return;
    try {
      if (!place) throw new Error("Not reached.");
      // Archived (from any app): kept until it's brought back, as its own wake-ups and goal wait,
      // rather than running a turn no one sees; a week at most.
      if (isPutAway(place.data as PutAwayable)) {
        if (Date.now() - waiting.since > ARCHIVED_FOR) return;
        throw new Error("Archived.");
      }
      // Stopped by the user: it waits there with the queue, as theirs does.
      const line = wakeLineShown(waiting.lines);
      await sendInto(place.target, starter, { id: messageID(), text: wakeText(waiting.lines), delivery: waiting.asks ? "steer" : "queue", metadata: boxNote("Its sessions", line) }, { from: "Its sessions", words: line });
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
  // Whether what happened while the box was down has been looked at: until then, what it hears
  // doesn't move when it last heard of everything (a box stopped meanwhile looks from then again),
  // nor once it's no longer followed (what it was still holding, told after).
  let caught = false;
  // The finishes it holds now.
  const holding = new Set<string>();
  const noteTold = (session: string, note: { reply?: string | null; ask?: string; at?: number; turn?: string | null }) => changeTold(toldFile, told => {
    const its = told.sessions[session] ?? {};
    if (note.reply) {
      its.reply = note.reply;
      if (told.held) delete told.held[session];
      if (told.held && !Object.keys(told.held).length) delete told.held;
    }
    if (note.at) its.at = note.at;
    if (note.turn) its.turn = note.turn;
    if (note.ask) its.asks = [...(its.asks ?? []).filter(each => each !== note.ask), note.ask].slice(-20);
    // Last, as the latest told of: the oldest are let go first.
    delete told.sessions[session];
    told.sessions[session] = its;
  }, caught && !signal?.aborted ? from : null, now());
  // A finish its starter may be waiting on (send_message with wait): once that wait ends, told unless
  // it ended with this reply, which came to it in the tool, or another watch (the engine's stream
  // connected again meanwhile) has dealt with it. Noted as held meanwhile, so a box started again
  // looks at it then. `at`: when its reply was read.
  const tellUnlessAnswered = (session: string, starter: string, reply: string | undefined, line: string, at: number, holds = false) => {
    const waited = awaitedBy(session, starter, reply);
    if (waited === "waits") {
      holding.add(session);
      if (!holds) changeTold(toldFile, told => { told.held = { ...told.held, [session]: { from, at: now() } }; }, null, now());
      const timer = schedule(async () => tellUnlessAnswered(session, starter, reply, line, at, true), AWAIT_LOOK);
      (timer as { unref?: () => void } | undefined)?.unref?.();
      return;
    }
    holding.delete(session);
    if (reply && readTold(toldFile)?.sessions[session]?.reply === reply) return noteTold(session, { reply });
    if (waited !== "answered") tell(starter, line, false);
    noteTold(session, { reply, at });
  };
  // What happened while the box was down (its link starting again), or while `source` couldn't be
  // heard: each followed session that finished, failed or asked since it last heard of any, and
  // hasn't been told, told now. Only once it could look at them all: until then (`source` slow, or
  // not there yet), looked at again a minute on, from the same time. A session it couldn't read
  // doesn't hold back the others: they're told, and it's looked at again (a few times).
  const before = readTold(toldFile);
  let tries = 0;
  const catchUp = async () => {
    if (!before) {
      caught = true;
      return changeTold(toldFile, () => {}, from, now());
    }
    const since = sinceOf(before, from);
    // (What changes from here on is looked at the next time, if it isn't heard of as it happens.)
    const looked = now();
    const listed = await workSessions([source], signal, { whole: true });
    const active = await call(source, "GET", "/api/session/active", undefined, signal);
    if (signal?.aborted) return;
    const working = new Set(Array.isArray(active) ? active : isObject(active) ? Object.keys(active) : []);
    const wasHeld = Object.keys(before.held ?? {}).filter(id => before.held![id].from === from);
    const followed = listed.filter(each => startedByOf(each.data) && wakesOf(each.data).length && ((each.data.time?.updated ?? 0) > since || wasHeld.includes(each.data.id)));
    const unread: Listed["data"][] = [];
    for (const { data } of followed) {
      if (signal?.aborted) return;
      await tellWhatHappened(data, working).catch(() => { unread.push(data); });
    }
    if (signal?.aborted) return;
    if (unread.length && ++tries < CATCH_UP_TRIES) throw new Error("Some of its sessions couldn't be read.");
    // Let go of for now: from just before them, looked at again as the box starts the next time
    // (until then, what it hears doesn't move past them); one it couldn't read on a few starts in a
    // row, for good.
    const starts = readTold(toldFile)?.unread ?? {};
    const held = unread.filter(data => (starts[data.id] ?? 0) + 1 < UNREAD_STARTS);
    caught = !held.length;
    changeTold(toldFile, told => {
      const counts = { ...told.unread };
      for (const { data } of followed) delete counts[data.id];
      for (const data of held) counts[data.id] = (starts[data.id] ?? 0) + 1;
      if (Object.keys(counts).length) told.unread = counts;
      else delete told.unread;
      // Held here as the box stopped, and looked at now: told, nothing to tell (gone since, or told
      // already), or held again. (One at work again, or unread, is looked at the next time.)
      for (const id of wasHeld) if (told.held && !holding.has(id) && !working.has(id) && !held.some(data => data.id === id)) delete told.held[id];
      if (told.held && !Object.keys(told.held).length) delete told.held;
    }, from, Math.min(looked, ...held.map(data => (data.time?.updated ?? 0) - 1)));
  };
  // What one followed session did that its starter hasn't been told; it throws when it can't be read.
  const tellWhatHappened = async (data: Listed["data"], working: Set<string>) => {
    const starter = startedByOf(data)!;
    const wakes = wakesOf(data);
    // (As told by now: one heard of meanwhile isn't told twice.)
    const was = readTold(toldFile)?.sessions[data.id] ?? {};
    if (wakes.includes("asks")) {
      const { permissions, questions } = await asksIn(source, data.id);
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
    if (!wakes.includes("finished") || working.has(data.id)) return;
    const at = now();
    const last = await lastReply(source, data.id);
    const outcome = (data as { outcome?: string }).outcome;
    const failed = outcome === "failed";
    const reply = last.id && last.id !== was.reply ? last.id : null;
    // A turn that failed before it replied (its model out of reach, say): told by its newest
    // message, once.
    const failedBare = failed && !reply && !!last.latest && ![was.turn, was.reply].includes(last.latest);
    if (!reply && !failedBare) return;
    // Told as it finished, its reply unread then: this one was there by then.
    if (reply && was.at && (last.at ?? data.time?.updated ?? Infinity) <= was.at) return noteTold(data.id, { reply });
    // Stopped (by you, or cut short): nothing to tell, as while the box runs.
    if (outcome === "interrupted") return noteTold(data.id, { reply });
    const line = await wakeLine({ type: failed ? "session.execution.failed" : "session.execution.succeeded", data: { sessionID: data.id } }, data, source);
    if (line && !failed) return tellUnlessAnswered(data.id, starter, reply!, line, at);
    if (line) tell(starter, line, false);
    noteTold(data.id, { reply, turn: failed ? last.latest : null });
  };
  const catchingUp = (): Promise<void> => catchUp().catch(() => {
    if (signal?.aborted) return;
    const timer = schedule(() => catchingUp(), CATCH_UP_AGAIN);
    (timer as { unref?: () => void } | undefined)?.unref?.();
  });
  const caughtUp = Promise.all([catchingUp(), tellLateAnswers(targets, undefined, bridgeRuns).catch(() => {})]).then(() => {});
  // Answers given late that waited (the coding agents' bridge not running), tried again every few
  // minutes while the box runs.
  const lateAgain = () => {
    if (signal?.aborted) return;
    const timer = schedule(async () => {
      if (signal?.aborted) return;
      await tellLateAnswers(targets, undefined, bridgeRuns).catch(() => {});
      lateAgain();
    }, LATE_AGAIN);
    (timer as { unref?: () => void } | undefined)?.unref?.();
  };
  void caughtUp.then(lateAgain);
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
      const at = now();
      const last = kind === "finished" ? await lastReply(source, session.id).catch(() => null) : null;
      const reply = last?.id ?? undefined;
      const line = await wakeLine(event, session, source);
      if (!line) return;
      if (event.type === "session.execution.succeeded") return tellUnlessAnswered(session.id, starter, reply, line, at);
      tell(starter, line, kind === "asks");
      const ask = event.data?.id ?? event.data?.form?.id;
      noteTold(session.id, kind === "asks" ? { ask: typeof ask === "string" ? ask : undefined } : { reply, at, turn: event.type === "session.execution.failed" ? last?.latest : null });
    })().catch(() => {});
  };
  return Object.assign(watch, { caughtUp });
}

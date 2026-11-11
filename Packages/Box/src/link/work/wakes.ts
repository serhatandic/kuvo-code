// A conversation hears of the sessions it started (PROTOCOL.md, "Work"): as one finishes, fails or
// asks for something, the box writes to it, as a wake-up does, so it never checks on them. Those
// that come close together go as one message, kept in `run/work/wakes.json` until they're sent, so
// none is lost to the box starting again; and what happened while it was down is told as it starts
// (`run/work/told.json` says what was). Each changes its bot's work, for clients to read again.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { cut } from "../../shared/text";
import { asked, call, engineGet, peerPlaces } from "../engine/client";
import { isBoxsOwnWord, sendInto } from "../engine/queue";
import { WAKE_MARKER } from "../areas/wakes";
import { boxNote } from "../../shared/queues";
import { messageID } from "../engine/sessions";
import { locked, writePrivate } from "../files";
import { NOTE_MEMORY, placeOfSession } from "../letters/letter";
import { tellMovedAway } from "../letters/outbox";
import { frozen } from "../moves/records";
import { isPutAway, type PutAwayable } from "../peers/directory";
import { ANSWERED, describeForm, describePermission, stillAsked } from "../notices/news";
import { noteOversight } from "./oversight";
import { noteWorkChanged, WORK_FOLDER } from "./changes";
import { asksIn } from "./answers";
import { catchUpAutopilot, declineSharedOnAutopilot, goAheadOnAutopilot, goAheadOnQuestion, isAutopilot } from "./autopilot";
import { settleAsk } from "./goals";
import { awaitedBy } from "./awaited";
import { tellLateAnswers } from "./asks";
import { errorOf, failedOn, followUnanswering, holdWords, turnError } from "./unanswering";
import { backgroundWatcher, forgetStopped, readStopped, startedSince, type BackgroundEvent, type BackgroundWork } from "./background";
import { summaryRowOf, isArchived, lastReplyOf, placeWords, startedByOf, wakesOf, workSessions, worksFor, type Listed } from "./tree";
import { projectNameOf } from "../notices/news";
import type { Target } from "../../shared/records";
import type { EngineSession } from "../engine/sessions";
import type { EngineForm, PermissionAsked } from "../notices/news";
import { ofTurn, pastSummaries, turnIn, workOutcome } from "../../shared/summaries";

export const WORK_WAKES = path.join(WORK_FOLDER, "wakes.json");
/** What each followed session's starter was told (its last reply's message, its asks), and when the
 * box last heard anything: what it missed while it was down is told as it starts again, once. */
export const WORK_TOLD = path.join(WORK_FOLDER, "told.json");
const LOCK = path.join(WORK_FOLDER, ".wakes.lock");
/** How long the box gathers what's to tell a conversation before it writes (ms). */
export const GATHER = 4000;
/** How long after what it left running ended a session is looked at again (ms): its agent is woken
 * by the end, and a turn of its own begins within this; else its word goes as it stands. */
export const SETTLE = 10_000;
/** What a turn nobody asked for must say, once a session's finish was told, to be told too (its
 * length in characters): a timer's "nothing new yet" isn't news. */
export const SUBSTANCE = 200;
/** How often a finish that waits on what its session left running looks whether that's over, in
 * case its end wasn't heard (ms). */
export const WAITING_LOOK = 10 * 60_000;

// The conversations being written to now, by wakes file: one message at a time to each, from
// whichever watcher (each connection to the engine makes one), so what one puts back, to go again
// as it was, is never overtaken.
const sending = new Set<string>();

/** What waits to be told a conversation: its lines, whether one is an ask (sent to be read at its
 * next step, not after its turn), and since when (ms). `tried`: its first lines went once already
 * under this id, and the answer was lost (the engine slow, say), so they may have arrived: they go
 * again alone under the same id, which a conversation takes once. */
interface Waiting {
  lines: string[];
  asks: boolean;
  since: number;
  tried?: { id: string; lines: number; asks: boolean };
}

/** An event the work watcher reads: a run that ended, a permission or a question asked, an ask
 * answered. */
export interface WorkEvent {
  type: string;
  location?: BackgroundEvent["location"];
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

/** A session as a line to its lead names it. */
function namedOf(session: Partial<EngineSession> & { id: string }): string {
  const folder = session.location?.directory ?? session.directory ?? "";
  return `"${session.title || "New Session"}" ${placeWords({ project: projectNameOf(folder), folder })} (address ${session.id})`;
}

/** What a conversation is told of a summary it asked of a session that failed. */
function notSummarizedLine(session: Partial<EngineSession> & { id: string }, why: string | undefined): string {
  return `[Session not summarized] ${namedOf(session)}: ${why ? cut(why.replace(/\.+$/, ""), 400) : "It couldn't"}. Its conversation and work are as they were.`;
}

/** What a conversation is told of one of its sessions, as a line, or null for nothing. */
export async function wakeLine(event: WorkEvent, session: Partial<EngineSession> & { id: string }, target: Target): Promise<string | null> {
  const named = namedOf(session);
  switch (event.type) {
    case "session.execution.succeeded": {
      const reply = await lastReplyOf({ target, data: session as never });
      const since = session.time?.created ? `, after ${took(Date.now() - session.time.created)}` : "";
      return `[Session finished] ${named}${since}:\n${reply ? cut(reply, 1200) : "(It ended without a reply.)"}`;
    }
    case "session.execution.failed": {
      // Why, in its engine's words; one at its account or its limit fails the same way again there.
      // (The event's own, as it happens; read from its conversation when caught up on later.)
      const error = errorOf((event.data as { error?: unknown }).error) ?? await turnError(target, session.id).catch(() => null);
      const held = error && session.model ? await failedOn(target, session.model, error).catch(() => null) : null;
      if (held) return `[Session failed] ${named} stopped: ${holdWords(held)}. Starting it again there fails the same way: start it again on a model that can, from list_models, or tell the user.`;
      const why = error?.message ? `: ${cut(error.message.replace(/\.+$/, ""), 400)}` : "";
      return `[Session failed] ${named} stopped with an error${why}. Read it with read_conversation, then start it again, try another way, or tell the user.`;
    }
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

/** What a lead is told of one of its sessions that the user stopped: only that, so it doesn't wait
 * on a session that won't finish now. */
export const stoppedLine = (session: Partial<EngineSession> & { id: string }) => `${STOPPED_OPENING} ${namedOf(session)} was stopped by the user. Nothing more comes from it unless it's written to again: don't start it or its work again unless the user asks.`;
const STOPPED_OPENING = "[Session stopped]";

/** What goes to a conversation, from the lines gathered for it. */
export const wakeText = (lines: string[]) => lines.join("\n\n");

/** What a conversation shows for the lines told it (`wakeLine`'s), in place of them: "“Sign-in”
 * finished", or how many there are. ("still working" is what boxes before #420 told a lead whose
 * session's turn ended while what it left running went on: still read, from a line kept.) */
export function wakeLineShown(lines: string[]): string {
  if (lines.length !== 1) return `${lines.length} updates from its sessions`;
  const said = /^\[Session (finished|still working|failed|asks|stopped)\] "([^"\n]*)"/.exec(lines[0]!);
  if (!said) return "News from a session";
  const what = said[1] === "finished" ? "finished" : said[1] === "still working" ? "still working" : said[1] === "failed" ? "stopped with an error" : said[1] === "stopped" ? "stopped by you" : "asks something";
  return `“${said[2] || "New Session"}” ${what}`;
}

// Each watcher here sending what waits for a conversation: told when a line's added from outside it.
const wakeSenders = new Set<(starter: string) => void>();

/** Lines for conversations from outside a watcher (a stop), each kept until it's sent with what
 * else waits for it, as one message. */
export function tellStarters(told: { starter: string; line: string }[], file = WORK_WAKES): void {
  if (!told.length) return;
  try {
    changeWaiting(file, all => {
      for (const { starter, line } of told) {
        const kept = all[starter] ?? { lines: [], asks: false, since: Date.now() };
        all[starter] = { ...kept, lines: [...kept.lines, line] };
      }
    });
  } catch {
    return;
  }
  for (const starter of new Set(told.map(each => each.starter))) for (const send of wakeSenders) send(starter);
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
   * message as a failed turn was told (one that failed before it replied ends with no reply).
   * `said`: what its reply told said, as a hash, and `early`: it was told while what it left running
   * ran or had only just ended, so what it says of that next is told too. `failure`: why its last
   * failed turn told failed. `upto`: when it had last changed as its finish was last told (as its
   * engine's clock says), and `unread`: its reply couldn't be read then (the engine slow), though
   * what it had written by then was told. */
  sessions: Record<string, { reply?: string; asks?: string[]; at?: number; turn?: string; said?: string; early?: boolean; failure?: string; upto?: number; unread?: boolean }>;
  unread?: Record<string, number>;
  held?: Record<string, { from: string; at: number }>;
  /** Those whose finish waits for what they left running: the place they run, since when, and when
   * the question its turn answered was asked (what ran before that doesn't hold it). */
  waiting?: Record<string, { from: string; at: number; asked?: number }>;
}
const readTold = (file: string): Told | null => {
  try {
    const kept = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!isObject(kept) || typeof kept.since !== "number") return null;
    const numbers = (value: unknown) => Object.fromEntries(Object.entries(isObject(value) ? value : {}).filter(([, number]) => typeof number === "number")) as Record<string, number>;
    const sinces = numbers(kept.sinces);
    const unread = numbers(kept.unread);
    const places = (value: unknown) => Object.fromEntries(Object.entries(isObject(value) ? value : {}).filter(([, each]) => isObject(each) && typeof each.from === "string" && typeof each.at === "number")) as Record<string, { from: string; at: number }>;
    const held = places(kept.held);
    const waiting = places(kept.waiting) as NonNullable<Told["waiting"]>;
    return { since: kept.since, ...(Object.keys(sinces).length ? { sinces } : {}), sessions: isObject(kept.sessions) ? kept.sessions as Told["sessions"] : {}, ...(Object.keys(unread).length ? { unread } : {}), ...(Object.keys(held).length ? { held } : {}), ...(Object.keys(waiting).length ? { waiting } : {}) };
  } catch {
    return null;
  }
};
/** Whether `session`'s finish is held now, its lead not told yet: waiting on what it left running,
 * or on its lead's own wait. */
export function finishHeld(session: string, file = WORK_TOLD): boolean {
  const told = readTold(file);
  return Boolean(told?.waiting?.[session] || told?.held?.[session]);
}
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

// Whether what a session left running holds its finish: any of it, or, for a turn that answered a
// question, only what began since that was asked (a dev server from before isn't its work).
const holds = (still: BackgroundWork | null | undefined, waited: { asked?: number }): boolean => Boolean(still) && (typeof waited.asked !== "number" || startedSince(still!, waited.asked));

// What said it, as a hash: whether a reply says the same again, whitespace aside.
const hashed = (text: string) => crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
/** What began a turn: someone's message (any in it counts, however it began), what the session left
 * running ending or its agent carrying on by itself, the box's own word (what a session it started
 * did, a limit that reset: what comes of it may be the result a lead waits for, so it's told, but it
 * doesn't set a stopped session going), its own wake-up, or a word of another kind (a goal given to it). */
interface Began { kind: "asked" | "left" | "word" | "timer" | "other"; at: number | null }
const messageTime = (message: { time?: unknown } | undefined) => isObject(message?.time) && typeof message.time.created === "number" ? message.time.created : null;
// From a turn's messages, newest first; a turn with no starter in reach counts as asked for.
function beganBy(turn: { type?: unknown; text?: unknown; metadata?: unknown; time?: unknown }[]): Began {
  const starters = turn.filter(message => message.type === "user" || message.type === "synthetic");
  const asked = starters.find(message => message.type === "user" && !isBoxsOwnWord(message.text, message.metadata));
  if (asked || !starters.length) return { kind: "asked", at: messageTime(asked) };
  const first = starters.at(-1)!;
  const at = messageTime(first);
  if (first.type === "user") return { kind: String(first.text ?? "").startsWith(WAKE_MARKER) ? "timer" : "word", at };
  const source = isObject(first.metadata) ? first.metadata.source : undefined;
  return { kind: source === "shell" || source === "subagent" || source === "agent" ? "left" : "other", at };
}

interface LastReply {
  id: string | null;
  at: number | null;
  turn: string | null;
  turnAt: number | null;
  /** What the turn said (empty for nothing). */
  text: string;
  /** What began the turn, and when it was written. */
  began: Began;
  /** Something's written since its last turn ended. */
  underWay: boolean;
  /** Its conversation, to read how its work went. */
  whole: unknown;
}

// A session's last reply (its id, and when it was written; null for none), the end of a turn
// started after it that wrote none (`turn`, its idle message, and when: a turn that failed
// before it replied), and what began its latest turn; it throws when it can't be read.
// A session's messages, newest first, back as far as its latest turn begins (a long one is many
// steps, each a message).
async function latestMessages(target: Target, session: string) {
  const address = encodeURIComponent(session);
  const messages: { id: string; type?: unknown; text?: unknown; metadata?: unknown; time?: unknown; content?: unknown }[] = [];
  let query = "limit=50&order=desc";
  for (let pages = 0; pages < 20; pages++) {
    // (A later page not read: as far as it got.)
    const page = await engineGet(target, `api/session/${address}/message?${query}`).catch(error => { if (pages === 0) throw error; return null; }) as { data?: unknown; cursor?: { next?: string; previous?: string } | null } | null;
    const data: unknown[] = Array.isArray(page?.data) ? page.data : [];
    for (const message of data) if (isObject(message) && typeof message.id === "string") messages.push(message as typeof messages[number]);
    const next = page?.cursor?.next ?? page?.cursor?.previous;
    if (!data.length || !next || turnIn(pastSummaries(messages)).before >= 0) break;
    query = `limit=100&cursor=${encodeURIComponent(next)}`;
  }
  return messages;
}

async function lastReply(target: Target, session: string): Promise<LastReply> {
  // (A summary asked for is no turn of its work: this is about what it did.)
  const whole = await latestMessages(target, session);
  const messages = pastSummaries(whole);
  const at = messageTime;
  const newest = (type: string) => { const index = messages.findIndex(message => message.type === type); return index < 0 ? Infinity : index; };
  const reply = messages[newest("assistant")];
  // Its latest turn, newest first: back to where the one before it ended (read as it runs too, not
  // ended yet). Words of the box's or its agent's can land anywhere in it.
  const { from, before } = turnIn(messages);
  const turn = messages.slice(from, before < 0 ? undefined : before);
  const ended = from > 0 && turn.length > 0 && !turn.some(message => message.type === "assistant") ? messages[from - 1] : undefined;
  // What it said in it, the latest first (a step of tools alone says nothing).
  let text = "";
  for (const message of turn) {
    if (message.type !== "assistant" || !Array.isArray(message.content)) continue;
    text = message.content.filter((part: unknown) => isObject(part) && part.type === "text").map((part: { text?: unknown }) => String(part.text ?? "")).join(" ").replace(/\s+/g, " ").trim();
    if (text) break;
  }
  return { id: reply?.id ?? null, at: at(reply), turn: ended?.id ?? null, turnAt: at(ended), text, began: beganBy(turn), underWay: from === 0 && turn.some(ofTurn), whole };
}

// Whether a finished turn is news to whoever started the session. The first it hears of it always is,
// and so is what it says of what it left running, once told before that was over (a timer of its own
// isn't that). After that a turn someone asked for is, and one that began on its own is only with
// something to say: not nothing, not the same again, not a line or two. Told last while its reply
// couldn't be read (the engine slow), a reply it had written by then was told then.
function isNews(was: Told["sessions"][string], last: LastReply): boolean {
  if (last.id && last.id === was.reply) return false;
  if (was.unread && was.upto !== undefined && last.at !== null && last.at <= was.upto) return false;
  if ((!was.at && !was.reply) || (was.early && last.began.kind !== "timer")) return true;
  if (last.began.kind === "asked" || last.began.kind === "word") return true;
  return last.text.length >= SUBSTANCE && hashed(last.text) !== was.said;
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
  /** Where what's running besides turns is kept, and which sessions were stopped. */
  backgroundFile?: string;
  stoppedFile?: string;
}

/** Follows `source`'s events for the work of bots and of any conversation that started sessions:
 * each one that ends or asks, told to whoever started it (as its `kuvo.wake` says), close ones as
 * one message; each, a change to its bot's work. `targets()`: where conversations here run. */
export function workWatcher(source: Target, targets: () => Target[], { gather = GATHER, schedule = setTimeout, now = Date.now, file = WORK_WAKES, toldFile = WORK_TOLD, bridgeRuns = () => peerPlaces().bridge, signal, from = ENGINE, backgroundFile, stoppedFile }: WorkWatch = {}): ((event: WorkEvent) => Promise<void>) & { caughtUp: Promise<void>; gone: () => void } {
  // (What runs stopping counting at its limit is looked at as an end is.)
  const background = backgroundWatcher(source, from, { file: backgroundFile, now, schedule, signal, ranOut: () => backgroundEnded() });
  const due = new Set<string>();
  // How many tries in a row each has failed, for the wait before the next.
  const failures = new Map<string, number>();
  const putBack = (starter: string, waiting: Waiting) => changeWaiting(file, all => {
    const now = all[starter];
    all[starter] = { lines: [...waiting.lines, ...(now?.lines ?? [])], asks: waiting.asks || Boolean(now?.asks), since: waiting.since, ...(waiting.tried ? { tried: waiting.tried } : {}) };
  });
  const send = async (starter: string) => {
    due.delete(starter);
    // (One at a time to each, whichever watcher sends it: what one puts back goes first.)
    const key = `${file}\n${starter}`;
    if (sending.has(key)) return soon(starter);
    sending.add(key);
    try {
      await sendNow(starter);
    } finally {
      sending.delete(key);
    }
  };
  const sendNow = async (starter: string) => {
    const waiting = changeWaiting(file, all => {
      const one = all[starter];
      delete all[starter];
      return one;
    });
    if (!waiting) return;
    // What went once already, its answer lost: again alone, under the same id (taken once if it
    // arrived), and what came after it next. One stopped since it was gathered: nothing to tell of it.
    const tried = waiting.tried && typeof waiting.tried.id === "string" && waiting.tried.lines > 0 && waiting.tried.lines <= waiting.lines.length ? waiting.tried : null;
    const stopped = readStopped(stoppedFile);
    // (What says it was stopped goes all the same.)
    const unstopped = (lines: string[]) => lines.filter(line => line.startsWith(STOPPED_OPENING) || !stopped[/\(address (\S+?)\)/.exec(line)?.[1] ?? ""]);
    const first = unstopped(tried ? waiting.lines.slice(0, tried.lines) : waiting.lines);
    const after = tried ? unstopped(waiting.lines.slice(tried.lines)) : [];
    const again = tried && first.length ? tried : null;
    const lines = again ? first : [...first, ...after];
    const rest = again ? after : [];
    if (!lines.length) return;
    const isAsk = (line: string) => line.startsWith("[Session asks]");
    const asks = again ? again.asks : tried ? lines.some(isAsk) : waiting.asks;
    const restAsks = rest.some(isAsk);
    const whole = [...lines, ...rest];
    const id = again?.id ?? messageID();
    // Gone for sure: nothing to tell. Not to be reached now (the engine starting again, the coding
    // agents' bridge not running, whose it may be, or moving to or from another computer, when a
    // turn here would be left behind): kept, as long as a note would be, and tried again a little
    // later each time. Living on another computer now, however long ago it left: told there, as a
    // letter.
    const place = frozen().has(starter) ? undefined : await placeOfSession(starter, targets()).catch(() => undefined);
    const line = wakeLineShown(lines);
    const delivery = asks ? "steer" : "queue";
    const about = [...new Set(whole.map(each => /\(address (\S+?)\)/.exec(each)?.[1]).filter((each): each is string => Boolean(each)))];
    if (place === null && tellMovedAway(starter, wakeText(whole), { from: "Its sessions", words: wakeLineShown(whole), line: wakeLineShown(whole), delivery: asks || restAsks ? "steer" : "queue", about }, now())) return void failures.delete(starter);
    if (place === null && (bridgeRuns() || now() - waiting.since > NOTE_MEMORY)) return;
    let posted = false;
    try {
      if (!place) throw new Error("Not reached.");
      // Archived (from any app): kept until it's brought back, as its own wake-ups and goal wait,
      // rather than running a turn no one sees; a week at most.
      if (isPutAway(place.data as PutAwayable)) {
        if (now() - waiting.since > ARCHIVED_FOR) return;
        throw new Error("Archived.");
      }
      // Stopped by the user: it waits there with the queue, as theirs does.
      posted = true;
      await sendInto(place.target, starter, { id, text: wakeText(lines), delivery, metadata: boxNote("Its sessions", line) }, { from: "Its sessions", words: line });
      failures.delete(starter);
    } catch {
      // (Sent, its answer lost, it may have arrived: kept with its id, to go again as it was.)
      putBack(starter, { lines: whole, asks: asks || restAsks, since: waiting.since, ...(posted || again ? { tried: { id, lines: lines.length, asks } } : {}) });
      const tries = (failures.get(starter) ?? 0) + 1;
      failures.set(starter, tries);
      soon(starter, Math.min(300_000, gather * 2 ** tries));
      return;
    }
    if (!rest.length) return;
    // (Ahead of what came meanwhile.)
    changeWaiting(file, all => {
      const now = all[starter];
      all[starter] = { lines: [...rest, ...(now?.lines ?? [])], asks: restAsks || Boolean(now?.asks), since: waiting.since };
    });
    soon(starter);
  };
  const soon = (starter: string, after = gather) => {
    if (due.has(starter)) return;
    due.add(starter);
    schedule(() => send(starter).catch(() => {}), after);
  };
  // What a box left waiting as it stopped: sent now; and what's added from outside, as it is.
  for (const starter of Object.keys(readWaiting(file))) soon(starter);
  const sendSoon = (starter: string) => soon(starter);
  wakeSenders.add(sendSoon);
  signal?.addEventListener("abort", () => wakeSenders.delete(sendSoon), { once: true });
  const sessions = new Map<string, Partial<EngineSession> & { id: string }>();
  const sessionOf = async (id: string) => {
    const data = await call(source, "GET", `/api/session/${encodeURIComponent(id)}`) as (Partial<EngineSession> & { id: string }) | null;
    if (data?.id) sessions.set(id, data);
    return data?.id ? data : null;
  };
  // A line for `starter`, kept until it's sent, and what it told noted.
  const tell = (starter: string, line: string, asks: boolean) => {
    changeWaiting(file, all => {
      const kept = all[starter] ?? { lines: [], asks: false, since: now() };
      all[starter] = { ...kept, lines: [...kept.lines, line], asks: kept.asks || asks };
    });
    soon(starter);
  };
  // Whether what happened while the box was down has been looked at: until then, what it hears
  // doesn't move when it last heard of everything (a box stopped meanwhile looks from then again),
  // nor once it's no longer followed (what it was still holding, told after).
  let caught = false;
  // The finishes it holds now.
  const holding = new Set<string>();
  const noteTold = (session: string, note: { reply?: string | null; ask?: string; at?: number; turn?: string | null; said?: string; early?: boolean; failure?: string; upto?: number; unread?: boolean }) => changeTold(toldFile, told => {
    const its = told.sessions[session] ?? {};
    if (note.reply) {
      its.reply = note.reply;
      delete its.unread;
      if (told.held) delete told.held[session];
      if (told.held && !Object.keys(told.held).length) delete told.held;
    }
    if (note.upto !== undefined) its.upto = note.upto;
    if (note.unread) its.unread = true;
    if (note.at) its.at = note.at;
    if (note.turn) its.turn = note.turn;
    if (note.said !== undefined) its.said = note.said;
    if (note.early !== undefined) {
      if (note.early) its.early = true;
      else delete its.early;
    }
    if (note.failure !== undefined) its.failure = note.failure;
    if (note.ask) its.asks = [...(its.asks ?? []).filter(each => each !== note.ask), note.ask].slice(-20);
    // Last, as the latest told of: the oldest are let go first.
    delete told.sessions[session];
    told.sessions[session] = its;
  }, caught && !signal?.aborted ? from : null, now());
  // A finish its starter may be waiting on (send_message with wait): once that wait ends, told unless
  // it ended with this reply, which came to it in the tool, or another watch (the engine's stream
  // connected again meanwhile) has dealt with it. Noted as held meanwhile, so a box started again
  // looks at it then. `at`: when its reply was read.
  const tellUnlessAnswered = (session: string, starter: string, reply: string | undefined, line: string, at: number, about: { said?: string; early: boolean; bot?: string; upto?: number }, holds = false) => {
    const waited = awaitedBy(session, starter, reply);
    if (waited === "waits") {
      holding.add(session);
      if (!holds) changeTold(toldFile, told => { told.held = { ...told.held, [session]: { from, at: now() } }; }, null, now());
      const timer = schedule(async () => tellUnlessAnswered(session, starter, reply, line, at, about, true), AWAIT_LOOK);
      (timer as { unref?: () => void } | undefined)?.unref?.();
      return;
    }
    holding.delete(session);
    const told = readTold(toldFile)?.sessions[session];
    if (reply && told?.reply === reply) return noteTold(session, { reply });
    // Told meanwhile by another look at the same finish (one is heard of in more than one way, and
    // on a busy computer a look takes minutes), where this one or that couldn't read its reply: that
    // one had seen all this one has, so it's been told.
    if ((!reply || told?.unread) && about.upto !== undefined && told?.upto !== undefined && about.upto <= told.upto) return reply ? noteTold(session, { reply }) : undefined;
    if (waited !== "answered") tell(starter, line, false);
    // One of a bot's sessions done: for clients to show it seeing that, once, as it's told.
    if (about.bot) noteOversight(about.bot, session, "finished");
    noteTold(session, { reply, at, said: about.said, early: about.early, upto: about.upto, unread: !reply });
  };
  // A finish waiting for what its session left running, no longer.
  const letGoOf = (session: string) => {
    if (readTold(toldFile)?.waiting?.[session]) changeTold(toldFile, told => {
      if (told.waiting) delete told.waiting[session];
      if (told.waiting && !Object.keys(told.waiting).length) delete told.waiting;
    }, null, now());
  };
  // Whether a session stopped hasn't been set going since, so nothing of it is news. What it left
  // running ending, or the box's own word, doesn't set it going; anything else written since does
  // (your message, a goal you gave it, a wake-up you added), and it's noted that it isn't stopped any more.
  const staysStopped = (session: string, last: LastReply | null): boolean => {
    const at = readStopped(stoppedFile)[session];
    if (at === undefined) return false;
    if (!last || last.began.kind === "left" || last.began.kind === "word" || (last.began.at ?? 0) <= at) return true;
    forgetStopped(session, stoppedFile);
    return false;
  };
  const settling = new Set<string>();
  const lookAgain = (session: string, after: number) => {
    const timer = schedule(async () => {
      settling.delete(session);
      // (Couldn't be read now: again in a while, or a command that never ends would never be told.)
      await settle(session).catch(() => { if (!signal?.aborted) lookAgain(session, CATCH_UP_AGAIN); });
    }, after);
    (timer as { unref?: () => void } | undefined)?.unref?.();
  };
  // Held: told nothing until what it left running is over (heard as it ends, as it stops counting at
  // its limit, or found every little while, in case its end wasn't heard), however long that takes.
  // `asked`: when the question its turn answered was asked, as what ran before that doesn't hold it.
  const waitFor = (session: string, since: number, asked: number | null) => {
    const was = readTold(toldFile)?.waiting?.[session];
    if (!was || was.asked !== (asked ?? undefined)) changeTold(toldFile, told => { told.waiting = { ...told.waiting, [session]: { from, at: was?.at ?? since, ...(asked !== null ? { asked } : {}) } }; }, null, now());
    lookWhileWaiting(session);
  };
  const looking = new Set<string>();
  const lookWhileWaiting = (session: string) => {
    if (looking.has(session) || signal?.aborted) return;
    looking.add(session);
    const timer = schedule(async () => {
      looking.delete(session);
      const waited = readTold(toldFile)?.waiting?.[session];
      if (signal?.aborted || !waited || waited.from !== from) return;
      const data = sessions.get(session);
      const still = await background.of(session, data?.location?.directory ?? data?.directory).catch(() => null);
      if (!holds(still, waited)) await settle(session).catch(() => {});
      if (readTold(toldFile)?.waiting?.[session]?.from === from) lookWhileWaiting(session);
    }, WAITING_LOOK);
    (timer as { unref?: () => void } | undefined)?.unref?.();
  };
  // A turn of a session that started by someone's asking ended well. Told to who started it, if it's
  // news (`isNews`) and nothing it left running still goes on; while that does, held, and looked at
  // as it ends. `known`: its last reply, if it's read.
  const finish = async (session: Partial<EngineSession> & { id: string }, starter: string, known?: LastReply) => {
    const at = now();
    // (As its engine says it last changed, before its reply is read: what it wrote by then.)
    const upto = typeof session.time?.updated === "number" ? session.time.updated : undefined;
    const last = known ?? await lastReply(source, session.id).catch(() => null);
    if (isArchived(session) || staysStopped(session.id, last)) {
      letGoOf(session.id);
      return noteTold(session.id, { reply: last?.id ?? undefined });
    }
    // Its reply unread (the engine slow), and at work again by now: told as that turn ends, so what
    // that turn writes meanwhile isn't taken as told here.
    if (!last) {
      const active = await call(source, "GET", "/api/session/active", undefined, signal).catch(() => null);
      if ((Array.isArray(active) ? active : isObject(active) ? Object.keys(active) : []).includes(session.id)) return;
    }
    const folder = session.location?.directory ?? session.directory;
    const still = await background.of(session.id, folder).catch(() => null);
    const waitedSince = readTold(toldFile)?.waiting?.[session.id]?.at;
    // (Someone's question isn't held up by what was running before they asked: a dev server.)
    const askedAt = last?.began.kind === "asked" ? last.began.at : null;
    if (holds(still, { asked: askedAt ?? undefined })) return waitFor(session.id, waitedSince ?? at, askedAt);
    const was = readTold(toldFile)?.sessions[session.id] ?? {};
    letGoOf(session.id);
    if (last && !isNews(was, last)) return noteTold(session.id, { reply: last.id ?? undefined });
    const line = await wakeLine({ type: "session.execution.succeeded", data: { sessionID: session.id } }, session, source);
    if (!line) return;
    const seen = Math.max(upto ?? -Infinity, last?.at ?? -Infinity);
    tellUnlessAnswered(session.id, starter, last?.id ?? undefined, line, at, { said: last ? (last.text ? hashed(last.text) : "") : undefined, early: Boolean(still) || waitedSince !== undefined, bot: worksFor(session)?.bot, upto: Number.isFinite(seen) ? seen : undefined });
  };
  // One whose finish waits, looked at now: gone, at work again (its end comes back here), or as above.
  const settle = async (id: string) => {
    if (signal?.aborted) return;
    const waited = readTold(toldFile)?.waiting?.[id];
    if (!waited || waited.from !== from) return;
    // (Gone, or moved away: nothing to wait for. Not reached now: looked at again.)
    const session = await sessionOf(id).catch(error => { if ((error as { status?: number }).status === 404) return null; throw error; });
    const starter = startedByOf(session);
    if (!session || !starter) return letGoOf(id);
    const active = await call(source, "GET", "/api/session/active", undefined, signal);
    if ((Array.isArray(active) ? active : isObject(active) ? Object.keys(active) : []).includes(id)) return;
    await finish(session, starter);
  };
  // Sessions of a bot's nobody is told of, whose finish is the bot's to see once what they left
  // running ends. (Only for a moment's show: lost with the box, as a mark would be.)
  const markLater = new Map<string, string>();
  // What it left running ended, as an event says: looked at again in a moment.
  const backgroundEnded = async () => {
    const waiting = readTold(toldFile)?.waiting ?? {};
    for (const [id, each] of Object.entries(waiting)) {
      if (each.from !== from || holds(background.known(id), each) || settling.has(id)) continue;
      settling.add(id);
      lookAgain(id, SETTLE);
    }
    for (const [id, bot] of markLater) {
      if (background.known(id)) continue;
      markLater.delete(id);
      if (!readStopped(stoppedFile)[id]) noteOversight(bot, id, "finished");
    }
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
      void background.start();
      return changeTold(toldFile, () => {}, from, now());
    }
    const since = sinceOf(before, from);
    // (What changes from here on is looked at the next time, if it isn't heard of as it happens.)
    const looked = now();
    const listed = await workSessions([source], signal, { whole: true });
    const active = await call(source, "GET", "/api/session/active", undefined, signal);
    await background.start();
    if (signal?.aborted) return;
    const working = new Set(Array.isArray(active) ? active : isObject(active) ? Object.keys(active) : []);
    const wasHeld = [...Object.keys(before.held ?? {}).filter(id => before.held![id].from === from), ...Object.keys(before.waiting ?? {}).filter(id => before.waiting![id].from === from)];
    const followed = listed.filter(each => startedByOf(each.data) && wakesOf(each.data).length && ((each.data.time?.updated ?? 0) > since || wasHeld.includes(each.data.id)));
    // One waited for that isn't listed now (deleted, moved, put away): looked at, and let go of.
    for (const id of Object.keys(before.waiting ?? {})) {
      if (before.waiting![id].from === from && !listed.some(each => each.data.id === id)) await settle(id).catch(() => {});
    }
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
    // (As told by now: one heard of meanwhile isn't told twice.)
    const was = readTold(toldFile)?.sessions[data.id] ?? {};
    let unreadAsks = false;
    if (wakesOf(data).includes("asks")) {
      const { permissions, questions, whole } = await asksIn(source, data.id);
      unreadAsks = !whole;
      for (const permission of permissions.filter(each => !was.asks?.includes(each.id))) {
        const line = await wakeLine({ type: "permission.asked", data: { id: permission.id, sessionID: data.id, action: permission.action, resources: permission.resources } as WorkEvent["data"] }, data, source);
        if (line) tell(starter, line, true);
        noteTold(data.id, { ask: permission.id });
      }
      for (const question of questions.filter(each => !was.asks?.includes(each.id))) {
        // On Autopilot nothing waits: it goes ahead here, as one heard as it's asked does.
        if (isAutopilot(data) && await goAheadOnQuestion(source, data, question).catch(() => null)) continue;
        tell(starter, `[Session asks] "${data.title || "New Session"}" (address ${data.id}) asks: ${question.text} (ask ${question.id}). Answer with answer_ask (answer), or tell the user in a line and carry on.`, true);
        noteTold(data.id, { ask: question.id });
      }
    }
    await tellIfFinished(data, working);
    // (Questions it couldn't read: it isn't past them, though it's told of the rest.)
    if (unreadAsks) throw new Error("Its questions couldn't be read.");
  };
  const tellIfFinished = async (data: Listed["data"], working: Set<string>) => {
    if (!wakesOf(data).includes("finished") || working.has(data.id)) return;
    const starter = startedByOf(data)!;
    const was = readTold(toldFile)?.sessions[data.id] ?? {};
    const at = now();
    const last = await lastReply(source, data.id);
    const waited = readTold(toldFile)?.waiting?.[data.id];
    // Its finish was waiting as the box stopped: looked at as it would have been.
    if (waited && waited.from === from) return finish(data, starter, last);
    // (Its work's, past a summary after it, whose own run says how that went.)
    const outcome = workOutcome(last.whole, (data as { outcome?: string }).outcome);
    const failed = outcome === "failed";
    const reply = last.id && last.id !== was.reply ? last.id : null;
    // A turn that failed before it replied (its model out of reach, say): told by its end, once
    // (not again for one that ended before it was told of).
    const failedBare = failed && !reply && !!last.turn && last.turn !== was.turn && !(was.at && (last.turnAt ?? Infinity) <= was.at);
    if (!reply && !failedBare) return;
    // Told as it finished, its reply unread then: this one was there by then.
    if (reply && was.at && (last.at ?? data.time?.updated ?? Infinity) <= was.at) return noteTold(data.id, { reply });
    // Stopped (by you, or cut short): nothing to tell, as while the box runs.
    if (outcome === "interrupted") return noteTold(data.id, { reply });
    if (!failed) return finish(data, starter, last);
    if (staysStopped(data.id, last)) return noteTold(data.id, { reply, turn: last.turn });
    const line = await wakeLine({ type: "session.execution.failed", data: { sessionID: data.id } }, data, source);
    if (line) tell(starter, line, false);
    noteTold(data.id, { reply, turn: last.turn });
  };
  // (Questions its conversations on Autopilot asked meanwhile go ahead first, however many tries it
  // takes to list them: no one is told of those. One it can't get through doesn't hold up telling
  // starters of the rest: it's looked at again a few times, and the box's next start looks again
  // after that.)
  let startersTold = false;
  let looksAgain = 0;
  const catchingUp = async (): Promise<void> => {
    if (signal?.aborted) return;
    let again = false;
    try {
      again = !await catchUpAutopilot(source, undefined, signal) && ++looksAgain < CATCH_UP_TRIES;
      if (signal?.aborted) return;
      if (!startersTold) await catchUp();
      startersTold = true;
    } catch {
      again = true;
    }
    if (!again || signal?.aborted) return;
    const timer = schedule(() => catchingUp(), CATCH_UP_AGAIN);
    (timer as { unref?: () => void } | undefined)?.unref?.();
  };
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
  // (What each event set going, for a test to wait on.) Models that couldn't answer, too: let go
  // once one answers, or an account's key changes.
  const watch = (event: WorkEvent) => Promise.all([followUnanswering(source, event).catch(() => {}), told(event), settled(event), background.noted(event).then(looked => (looked ? backgroundEnded() : undefined)).catch(() => {})]).then(() => {});
  // An ask answered or skipped: what stands for it on a goal goes at once.
  const settled = async (event: WorkEvent) => {
    if (!ANSWERED.has(event.type)) return;
    const ask = event.data?.requestID ?? event.data?.id;
    if (typeof ask === "string") settleAsk(ask);
  };
  const told = (event: WorkEvent) => {
    const id = event.data?.sessionID ?? event.data?.form?.sessionID;
    if (typeof id !== "string" || !["session.inbox.delivered", "session.execution.started", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted", "permission.asked", "form.created", "permission.replied", "form.replied"].includes(event.type)) return Promise.resolve();
    // What an MCP server asks is filed under no session.
    if (id === "global") return event.data?.form ? declineSharedOnAutopilot(source, event.data.form as unknown as Record<string, unknown>, event.location?.directory).then(() => {}, () => {}) : undefined;
    return (async () => {
      // A subagent's ask is its conversation's.
      let session = await sessionOf(id);
      for (let step = 0; session?.parentID && step < 5; step++) session = await sessionOf(session.parentID);
      if (!session || (session.id !== id && (event.type.startsWith("session.execution") || event.type === "session.inbox.delivered"))) return;
      const starter = startedByOf(session);
      const wakes = wakesOf(session);
      // Something written to a session of someone's that was stopped or put away, in its conversation
      // by now (as a turn starts it may not be yet). What it left running ending stops there, as that
      // began no turn anyone wanted; anything else goes on, and a stopped one is no longer stopped.
      if (event.type === "session.inbox.delivered") {
        const stopped = readStopped(stoppedFile)[session.id] !== undefined;
        if (!starter || (!stopped && !isArchived(session))) return;
        const began = await lastReply(source, session.id).catch(() => null);
        if (!began?.underWay) return;
        if (stopped && !staysStopped(session.id, began)) return;
        if (began.began.kind === "left" || (stopped && began.began.kind === "word")) await call(source, "POST", `/api/session/${encodeURIComponent(session.id)}/interrupt`).catch(() => {});
        return;
      }
      const bot = worksFor(session)?.bot;
      if (bot) noteWorkChanged(bot);
      // Only a summary it was asked for: not news, and not its work finishing. One that failed says
      // only that, whichever way its run ended (the engine's says `succeeded`). A finish that waited
      // on what it left running, over meanwhile, is looked at now, and stands either way.
      if (event.type === "session.execution.succeeded" || event.type === "session.execution.failed") {
        const summary = await summaryRowOf(source, session.id);
        if (summary?.status === "failed") {
          if (starter && wakes.includes("finished") && !isArchived(session) && readStopped(stoppedFile)[session.id] === undefined) {
            const error = errorOf((event.data as { error?: unknown }).error) ?? errorOf(summary.error);
            tell(starter, notSummarizedLine(session, error?.message), false);
          }
          return await settle(session.id);
        }
        if (summary?.status === "completed" && event.type === "session.execution.succeeded") return await settle(session.id);
      }
      // On Autopilot nothing waits: a question goes ahead on the choice it marks, or comes back declined.
      const form = event.type === "form.created" ? event.data?.form ?? event.data as unknown as EngineForm : null;
      if (form && isAutopilot(session)) {
        const asked = { ...form, sessionID: form.sessionID ?? id };
        if (await goAheadOnAutopilot(source, session, asked).catch(() => null)) return;
        // Gone before it could be answered (you got there first): nothing to put to anyone.
        if (!await stillAsked(asked, route => engineGet(source, route))) return;
      }
      // (One starting or stopped is its bot's work changing, for clients to read: nothing to tell.)
      const kind = event.type === "session.execution.succeeded" || event.type === "session.execution.failed" ? "finished" : event.type.endsWith(".asked") || event.type === "form.created" ? "asks" : null;
      if (event.type === "session.execution.succeeded" && (!starter || !wakes.includes("finished"))) {
        // Quiet to its starter, but still its bot's to see, once it's really done.
        const folder = session.location?.directory ?? session.directory;
        if (!bot || isArchived(session) || readStopped(stoppedFile)[session.id]) return;
        if (await background.of(session.id, folder).catch(() => null)) markLater.set(session.id, bot);
        else noteOversight(bot, session.id, "finished");
        return;
      }
      if (!starter || !kind || !wakes.includes(kind)) return;
      if (event.type === "session.execution.succeeded") return finish(session, starter);
      if (kind === "asks") {
        // From one stopped or put away, nothing: what it asks went with its stop.
        if (isArchived(session) || readStopped(stoppedFile)[session.id] !== undefined) return;
        const line = await wakeLine(event, session, source);
        if (!line) return;
        tell(starter, line, true);
        const ask = event.data?.id ?? event.data?.form?.id;
        return noteTold(session.id, { ask: typeof ask === "string" ? ask : undefined });
      }
      // A turn that failed.
      const at = now();
      const last = await lastReply(source, session.id).catch(() => null);
      const reply = last?.id ?? undefined;
      if (isArchived(session) || staysStopped(session.id, last)) {
        letGoOf(session.id);
        return noteTold(session.id, { reply, turn: last?.turn });
      }
      // The same failure again, in a turn no one asked for (a timer's, at a limit): told once.
      const failure = errorOf((event.data as { error?: unknown }).error)?.message ?? "";
      if (failure && last && last.began.kind !== "asked" && readTold(toldFile)?.sessions[session.id]?.failure === failure) return noteTold(session.id, { reply, turn: last.turn });
      const line = await wakeLine(event, session, source);
      if (!line) return;
      tell(starter, line, false);
      letGoOf(session.id);
      noteTold(session.id, { reply, at, turn: last?.turn, failure });
    })().catch(() => {});
  };
  return Object.assign(watch, { caughtUp, gone: () => { wakeSenders.delete(sendSoon); background.gone(); } });
}

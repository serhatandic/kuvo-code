// The queue (PROTOCOL.md, "The queue")
// The engine keeps what you send in a session's inbox: a message for the agent's next step
// (`steer`), or one that waits for the run to end (`queue`). The engine doesn't start the next one
// after an interrupt, nor in every case after a run, so every box carries its queue on itself, the
// same for every client and with none connected: once a run ends, after a moment, the next one
// goes. A run that fails, a Stop (from any client), and a queue found with nothing running once
// the engine started again pause it until Resume; Stop holds what was for the next step ahead of
// the queue, the latest Stop's first. Kept in `run/queues.json`, by session.

import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { locked, writePrivate } from "../files";
import { RUN } from "../home";
import { asked } from "./client";
import { messageID } from "./sessions";
import type { Target } from "../../shared/records";

export const QUEUES_FILE = path.join(RUN, "queues.json");
/** What waits on the box for a paused conversation, whole, as it goes to the engine: `<message id>.json`. */
export const WAITING_DIR = path.join(RUN, "waiting");
const QUEUES_LOCK = path.join(RUN, ".queues.lock");
/** How long after a run ends (or a message is queued while none runs) the next one goes: the engine
 * may still be handing over what it had. */
export const DRAIN_AFTER = 1500;

/** A session's queue as the box keeps it: whether it waits for Resume, and what Stop held for the
 * next step, in the order it goes (ahead of the queue). */
export interface QueueState {
  paused: boolean;
  held: string[];
  /** When Resume or Send Now last went on with it (ms): a Stop's look at an interrupt from before
   * that leaves it going. Kept a minute, never in a route's answer. */
  resumed?: number;
  /** What waits on the box until the queue goes on, first come first (none: left out). */
  waiting?: Waiting[];
}

/** A message waiting on the box for a paused conversation, as clients show it: who it's from (an
 * agent's name, "Wake-up"…; none for one of yours), what it says, the names of the files it
 * carries, and when it came (ms). */
export interface Waiting {
  id: string;
  from?: string;
  text: string;
  files?: string[];
  at: number;
}

/** A message to a conversation, as the engine's `prompt` takes it. */
export interface Outgoing {
  id?: string;
  text: string;
  files?: unknown[];
  delivery: "steer" | "queue";
}

/** A message in a session's inbox, as far as the queue reads it. */
interface InboxEntry {
  id: string;
  delivery: "steer" | "queue";
}

// (A message's id names its file in `run/waiting`.)
const WAITING_ID = /^msg_[A-Za-z0-9]{1,80}$/;

const keptWaiting = (value: unknown): Waiting[] => (Array.isArray(value) ? value : []).flatMap(item => {
  if (!isObject(item) || typeof item.id !== "string" || !WAITING_ID.test(item.id) || typeof item.text !== "string") return [];
  const files = Array.isArray(item.files) ? item.files.filter((name): name is string => typeof name === "string") : [];
  return [{ id: item.id, ...(typeof item.from === "string" ? { from: item.from } : {}), text: item.text, ...(files.length ? { files } : {}), at: typeof item.at === "number" ? item.at : 0 }];
});

const keptState = (value: unknown): QueueState => {
  const waiting = keptWaiting(isObject(value) ? value.waiting : undefined);
  return {
    paused: isObject(value) && value.paused === true,
    held: isObject(value) && Array.isArray(value.held) ? value.held.filter((id): id is string => typeof id === "string") : [],
    ...(isObject(value) && typeof value.resumed === "number" ? { resumed: value.resumed } : {}),
    ...(waiting.length ? { waiting } : {}),
  };
};

/** A queue as a client reads it. */
export const shownQueue = ({ paused, held, waiting }: QueueState): QueueState => ({ paused, held, ...(waiting?.length ? { waiting } : {}) });
/** Whether a client is shown it (`kuvo/sessions/queues/events`): paused, or holding something. */
export const showsQueue = (state: QueueState) => state.paused || state.held.length > 0 || Boolean(state.waiting?.length);
const RESUMED_FOR = 60_000;

/** Every session's queue the box keeps (one that's neither paused nor holds anything isn't kept). */
export function readQueues(file = QUEUES_FILE): Record<string, QueueState> {
  let all: unknown = {};
  try { all = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  return isObject(all) ? Object.fromEntries(Object.entries(all).map(([session, state]) => [session, keptState(state)])) : {};
}

export const queueOf = (session: string, file = QUEUES_FILE): QueueState => readQueues(file)[session] ?? { paused: false, held: [] };

/** Told of each change this process makes (`kuvo/sessions/queues/events`). */
export const queueFollowers = new Set<() => void>();

/** `session`'s queue as `change` makes it, read again just before, under its lock. */
export function changeQueue(session: string, change: (state: QueueState) => QueueState, file = QUEUES_FILE): QueueState {
  let changed = false;
  const after = locked(QUEUES_LOCK, () => {
    const all = readQueues(file);
    const before = all[session] ?? { paused: false, held: [] };
    const made = keptState(change(before));
    made.held = [...new Set(made.held)];
    changed = JSON.stringify(made) !== JSON.stringify(before);
    if (!changed) return made;
    all[session] = made;
    // Kept while it's paused, holds something, or was resumed a moment ago.
    for (const [id, state] of Object.entries(all)) {
      if (state.resumed && Date.now() - state.resumed >= RESUMED_FOR) delete state.resumed;
      if (!showsQueue(state) && !state.resumed) delete all[id];
    }
    try { writePrivate(file, JSON.stringify(all)); } catch {}
    return made;
  });
  if (changed) for (const tell of queueFollowers) tell();
  return after;
}

const address = (session: string) => encodeURIComponent(session);

async function inboxOf(target: Target, session: string): Promise<InboxEntry[]> {
  const answer = await asked(target, "GET", `api/session/${address(session)}/inbox`) as { data?: unknown } | null;
  return Array.isArray(answer?.data) ? answer.data.filter((item): item is InboxEntry => isObject(item) && typeof item.id === "string" && (item.delivery === "steer" || item.delivery === "queue")) : [];
}

// (As the engine and the agents' bridge answer it: the sessions at work, as a list or by id.)
async function isRunning(target: Target, session: string): Promise<boolean> {
  const active = (await asked(target, "GET", "api/session/active") as { data?: string[] | Record<string, unknown> } | null)?.data ?? {};
  return Array.isArray(active) ? active.includes(session) : Boolean(active[session]);
}

const setDelivery = (target: Target, session: string, item: string, delivery: InboxEntry["delivery"]) =>
  asked(target, "PATCH", `api/session/${address(session)}/inbox/${address(item)}`, { delivery });
const interrupt = (target: Target, session: string, resume = false) =>
  asked(target, "POST", `api/session/${address(session)}/interrupt${resume ? "?resume=true" : ""}`);

/** What goes next: what Stop held, in its order, then a message for the next step, then the queue. */
export function nextOf(inbox: InboxEntry[], held: string[]): InboxEntry | null {
  for (const id of held) {
    const found = inbox.find(item => item.id === id);
    if (found) return found;
  }
  return inbox.find(item => item.delivery === "steer") ?? inbox.find(item => item.delivery === "queue") ?? null;
}

// The names of the files a message carries, as clients show them.
const fileNames = (files: unknown[] | undefined): string[] => (files ?? []).flatMap(file => {
  if (!isObject(file)) return [];
  if (typeof file.name === "string" && file.name) return [file.name];
  return typeof file.uri === "string" && !file.uri.startsWith("data:") ? [path.basename(decodeURIComponent(file.uri.replace(/^file:\/\//, "")))] : ["file"];
});

const waitingFile = (id: string) => path.join(WAITING_DIR, `${id}.json`);

/** How a message waiting on the box is shown and kept: who it's from, what it says as clients show
 * it, and what goes instead of its text once it waits (a letter whose sender stops waiting). */
export interface Shown {
  from?: string;
  words?: string;
  kept?: string;
}

/** `message` kept on the box while `session`'s queue is paused (see `Shown`): true. Not paused,
 * false: it isn't kept. */
export function keepWaiting(session: string, message: Outgoing & { id: string }, { from, words, kept: keptText }: Shown = {}): boolean {
  let kept = false;
  changeQueue(session, state => {
    if (!state.paused) return state;
    writePrivate(waitingFile(message.id), JSON.stringify(keptText === undefined ? message : { ...message, text: keptText }));
    kept = true;
    const files = fileNames(message.files);
    const waiting: Waiting = { id: message.id, ...(from ? { from } : {}), text: words ?? message.text, ...(files.length ? { files } : {}), at: Date.now() };
    return { ...state, waiting: [...(state.waiting ?? []).filter(each => each.id !== message.id), waiting] };
  });
  return kept;
}

/** `message` to `session`, from the box itself (another agent's letter, a wake-up, a bot's work
 * news, an answer's note): while its queue is paused, kept to go once it goes on ("waits", see
 * `keepWaiting`); else sent now ("sent"). It throws when the engine doesn't take it. */
export async function sendInto(target: Target, session: string, message: Outgoing, shown: Shown = {}): Promise<"sent" | "waits"> {
  const whole = { ...message, id: message.id ?? messageID() };
  if (keepWaiting(session, whole, shown)) return "waits";
  await asked(target, "POST", `api/session/${address(session)}/prompt`, whole);
  return "sent";
}

/** `item` (else the first) taken from what waits on the box for `session` (`resume`: the queue no
 * longer paused either): how it was shown, and what goes, whole (null if its file is lost); null
 * when it isn't waiting. */
function takeWaiting(session: string, item?: string, resume = false): { shown: Waiting; message: (Outgoing & { id: string }) | null } | null {
  let shown: Waiting | undefined;
  changeQueue(session, state => {
    shown = item ? state.waiting?.find(each => each.id === item) : state.waiting?.[0];
    if (!shown) return state;
    return { ...state, ...(resume ? { paused: false, resumed: Date.now() } : {}), waiting: state.waiting!.filter(each => each !== shown) };
  });
  if (!shown) return null;
  let whole: unknown = null;
  try { whole = JSON.parse(fs.readFileSync(waitingFile(shown.id), "utf8")); } catch {}
  fs.rmSync(waitingFile(shown.id), { force: true });
  const message = isObject(whole) && typeof whole.text === "string" && (whole.delivery === "steer" || whole.delivery === "queue")
    ? { id: shown.id, text: whole.text, delivery: whole.delivery, ...(Array.isArray(whole.files) ? { files: whole.files } : {}) } as Outgoing & { id: string }
    : null;
  return { shown, message };
}

/** One taken away from what waits on the box (Remove, or Edit): how it was shown and what would
 * have gone (for Undo to put back as it was); null when it isn't there. */
export function dropWaiting(session: string, item: string): ReturnType<typeof takeWaiting> {
  return takeWaiting(session, item);
}

/** `session`'s next waiting message started, unless its queue is paused or a run is under way: a
 * queued one by steering it (which starts a run), one for the next step by resuming; with none in
 * the engine's inbox, the first waiting on the box, sent to go now. */
export async function drain(target: Target, session: string): Promise<void> {
  if (queueOf(session).paused || (await isRunning(target, session))) return;
  const next = nextOf(await inboxOf(target, session), queueOf(session).held);
  // (Stopped, or started, while it looked: as it is now.)
  if (queueOf(session).paused || (await isRunning(target, session))) return;
  if (!next) return sendWaiting(target, session);
  if (next.delivery === "queue") await setDelivery(target, session, next.id, "steer");
  else await interrupt(target, session, true);
  changeQueue(session, state => ({ ...state, held: state.held.filter(id => id !== next.id) }));
}

// The first message waiting on the box for `session`, to go now (nothing runs): first again if the
// engine doesn't take it, unless the conversation is gone.
async function sendWaiting(target: Target, session: string): Promise<void> {
  let first = takeWaiting(session);
  // (One whose contents were lost goes no further.)
  while (first && !first.message) first = takeWaiting(session);
  if (!first?.message) return;
  try {
    await asked(target, "POST", `api/session/${address(session)}/prompt`, { ...first.message, delivery: "steer" });
  } catch (error) {
    if (/ 404\.$/.test(String((error as Error | null)?.message))) return;
    putBack(session, first.message, first.shown);
    throw error;
  }
}

// A message taken to go that didn't: first again in what waits, as it was shown.
function putBack(session: string, message: Outgoing & { id: string }, shown: Waiting) {
  changeQueue(session, state => {
    writePrivate(waitingFile(message.id), JSON.stringify(message));
    return { ...state, waiting: [shown, ...(state.waiting ?? []).filter(each => each.id !== shown.id)] };
  });
}

/** What waits for `session`'s next step held in its queue, ahead of what was queued (the latest
 * first), and the queue paused when anything waits: what Stop does before it stops the run, and a
 * failed run's. */
// `since`: for an interrupt then (ms), unless Resume or Send Now went on with it after. `items`:
// messages a client held as they went (queued or not), put first, in that order.
export async function holdQueue(target: Target, session: string, since?: number, items: string[] = []): Promise<QueueState> {
  const resumedSince = () => since !== undefined && (queueOf(session).resumed ?? 0) >= since;
  const inbox = await inboxOf(target, session);
  if (resumedSince()) return queueOf(session);
  const held = queueOf(session).held;
  const named = items.filter(id => inbox.some(item => item.id === id));
  const steering = inbox.filter(item => item.delivery === "steer" && !held.includes(item.id) && !named.includes(item.id)).map(item => item.id);
  // Held only once it's in the queue (the agent may take one first).
  const moved: string[] = [];
  for (const id of [...named, ...steering]) {
    if (inbox.find(item => item.id === id)?.delivery !== "steer") moved.push(id);
    else if (await setDelivery(target, session, id, "queue").then(() => true, () => false)) moved.push(id);
  }
  const waiting = await inboxOf(target, session).catch(() => inbox);
  const there = (id: string) => waiting.some(item => item.id === id);
  return changeQueue(session, state => (since !== undefined && (state.resumed ?? 0) >= since ? state
    : { ...state, paused: state.paused || waiting.length > 0, held: [...moved.filter(there), ...state.held.filter(id => !moved.includes(id) && there(id))] }));
}

/** Stop: what waits held, the queue paused whether anything waits or not (what arrives later waits
 * on the box), then the run stopped. `holds` false (a bot stopping a session of its work, which it
 * may write to again): paused only when something waits, as a failed run's. */
export async function stopSession(target: Target, session: string, holds = true): Promise<QueueState> {
  const held = await holdQueue(target, session);
  const state = holds ? changeQueue(session, current => ({ ...current, paused: true })) : held;
  await interrupt(target, session);
  return state;
}

/** Resume: the queue goes on, its next message now. */
export async function resumeQueue(target: Target, session: string): Promise<QueueState> {
  changeQueue(session, current => ({ ...current, paused: false, resumed: Date.now() }));
  await drain(target, session);
  return queueOf(session);
}

/** Send Now: `item` to the agent right away, the step under way stopped for it (one that runs goes
 * on from there with it), the queue no longer paused. False when it isn't waiting. */
export async function sendNow(target: Target, session: string, item: string): Promise<boolean> {
  // One waiting on the box: to the engine for now.
  const kept = takeWaiting(session, item, true);
  if (kept) {
    if (!kept.message) return false;
    const running = await isRunning(target, session);
    try {
      await asked(target, "POST", `api/session/${address(session)}/prompt`, { ...kept.message, delivery: "steer" });
    } catch (error) {
      putBack(session, kept.message, kept.shown);
      throw error;
    }
    if (running) await interrupt(target, session, true);
    return true;
  }
  const entry = (await inboxOf(target, session)).find(each => each.id === item);
  if (!entry) return false;
  changeQueue(session, state => ({ paused: false, held: state.held.filter(id => id !== item), resumed: Date.now() }));
  const running = await isRunning(target, session);
  // Steering wakes an idle session; a running one gets it once the step stops.
  if (entry.delivery === "queue") await setDelivery(target, session, item, "steer");
  if (running || entry.delivery === "steer") await interrupt(target, session, true);
  return true;
}

/** An event, as far as the queue reads it. */
export interface QueueEvent {
  type: string;
  data?: { sessionID?: string; inboxID?: string; item?: { type?: string; delivery?: string; payload?: { text?: unknown } }; reason?: string };
}

// A message you wrote, not one Kuvo Code sent the agent for you or another (an agent's letter, a
// wake-up, a group chat's work, a note).
const NOT_YOURS = ["[Message from ", "[Wake-up]", "[Work from ", "[Session "];
const isYours = (item: NonNullable<NonNullable<QueueEvent["data"]>["item"]>) =>
  item.type === "user" && !NOT_YOURS.some(start => String(item.payload?.text ?? "").startsWith(start));

/** How the queue's watcher waits (a test's clock). */
export interface QueueWatch {
  after?: number;
  schedule?: (run: () => void, ms: number) => unknown;
  cancel?: (timer: unknown) => void;
}

/** What the box does with its engine's (or the coding agents' bridge's) events for the queue. A
 * run that ends well: the next message, a moment later. Stopped (the engine says by you, or as it
 * shut down; the bridge says nothing): held and paused a moment later, unless a run started again
 * meanwhile (Send Now's resume does at once), whichever client stopped it; one the engine ended
 * itself (superseded, idle too long) goes on as one that ended well. Failed: held and paused. A message queued while nothing runs: it goes, a moment
 * later; one for the next step: the queue isn't paused any more (you sent a message to go now).
 * One delivered or taken back leaves what's held. Paused, it stays so until Resume, Send Now or a
 * message of yours to go now, though nothing is left waiting: what arrives then waits on the box. */
export function queueWatcher(target: Target, { after = DRAIN_AFTER, schedule = setTimeout, cancel = clearTimeout as (timer: unknown) => void }: QueueWatch = {}): (event: QueueEvent) => void {
  const drains = new Map<string, unknown>();
  const stops = new Map<string, unknown>();
  const later = (timers: Map<string, unknown>, session: string, work: () => Promise<unknown>) => {
    if (timers.has(session)) cancel(timers.get(session));
    timers.set(session, schedule(() => {
      timers.delete(session);
      work().catch(() => {});
    }, after));
  };
  const forget = (timers: Map<string, unknown>, session: string) => {
    if (timers.has(session)) cancel(timers.get(session));
    timers.delete(session);
  };
  return event => {
    const session = event.data?.sessionID;
    if (!session) return;
    switch (event.type) {
      case "session.execution.started":
        forget(drains, session);
        forget(stops, session);
        break;
      case "session.execution.succeeded":
        forget(stops, session);
        later(drains, session, () => drain(target, session).catch(() => drain(target, session)));
        break;
      case "session.execution.interrupted": {
        if (event.data?.reason === "superseded" || event.data?.reason === "inactivity") {
          later(drains, session, () => drain(target, session));
          break;
        }
        // (Not when it was resumed since: Resume or Send Now goes on.)
        const at = Date.now();
        // Still at work a moment later (the bridge keeping files after a turn): looked at again,
        // a few times.
        const look = (left: number): void => later(stops, session, async () => {
          if (!(await isRunning(target, session))) await holdQueue(target, session, at);
          else if (left > 0) look(left - 1);
        });
        look(10);
        break;
      }
      case "session.execution.failed":
        forget(stops, session);
        holdQueue(target, session).catch(() => {});
        break;
      case "session.inbox.enqueued":
        // You writing to it for now: it goes on. (Not a letter, a wake-up or a note.)
        if (event.data?.item?.delivery === "steer" && isYours(event.data.item)) changeQueue(session, state => ({ ...state, paused: false }));
        else if (!queueOf(session).paused) later(drains, session, () => drain(target, session));
        break;
      case "session.inbox.delivered":
      case "session.inbox.cancelled": {
        const gone = event.data?.inboxID;
        if (!queueOf(session).held.length) break;
        inboxOf(target, session).then(inbox => changeQueue(session, state => ({
          ...state,
          held: state.held.filter(id => id !== gone && inbox.some(item => item.id === id)),
        }))).catch(() => {});
        break;
      }
    }
  };
}

// The engine (or the agents' bridge) whose queues were last looked over, by its port, kept in
// `run/` so a box that starts again beside the same engine doesn't take it for a new one.
const SCANNED_FILE = path.join(RUN, "queues-scanned.json");

// Whether `session`'s last run was stopped or failed, as its newest message says (an answer that
// ended in an error); unknown, it was.
async function endedBadly(target: Target, session: string): Promise<boolean> {
  const page = await asked(target, "GET", `api/session/${address(session)}/message?limit=1&order=desc`).catch(() => null) as { data?: { type?: string; error?: unknown }[] } | null;
  if (!Array.isArray(page?.data)) return true;
  const last = page.data[0];
  return last?.type === "assistant" && isObject(last.error);
}

/** Once for each engine started anew (its process changed): each of its latest sessions with
 * messages waiting and nothing running held and paused, as Stop holds them. The same engine (the
 * box started again, or its stream dropped and came back): their queues go on, as after a run
 * that ended while it couldn't hear; held and paused as above if it was stopped or failed. */
export async function scanQueues(target: Target & { pid?: number }): Promise<void> {
  const known = locked(QUEUES_LOCK, () => {
    let scanned: Record<string, unknown> = {};
    try { scanned = JSON.parse(fs.readFileSync(SCANNED_FILE, "utf8")) ?? {}; } catch {}
    if (target.pid !== undefined && scanned[target.port] === target.pid) return true;
    scanned[target.port] = target.pid;
    try { writePrivate(SCANNED_FILE, JSON.stringify(scanned)); } catch {}
    return false;
  });
  const page = await asked(target, "GET", "api/session?parentID=null&limit=100&order=desc") as { data?: { id?: string; time?: { updated?: number } }[] } | null;
  const week = Date.now() - 7 * 86_400_000;
  for (const session of page?.data ?? []) {
    if (typeof session.id !== "string" || (session.time?.updated ?? 0) < week) continue;
    try {
      if (!(await inboxOf(target, session.id)).length || (await isRunning(target, session.id))) continue;
      if (known && !(await endedBadly(target, session.id))) await drain(target, session.id);
      else await holdQueue(target, session.id);
    } catch {}
  }
  // What waits on the box for one that isn't paused (the box stopped before it went): it goes now.
  // (A session of the engine's or the bridge's: the other one doesn't have it, and keeps it.)
  for (const [session, state] of Object.entries(readQueues())) {
    if (state.paused || !state.waiting?.length) continue;
    try {
      await asked(target, "GET", `api/session/${address(session)}`);
    } catch {
      continue;
    }
    await drain(target, session).catch(() => {});
  }
}

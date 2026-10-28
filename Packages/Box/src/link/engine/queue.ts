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
import type { Target } from "../../shared/records";

export const QUEUES_FILE = path.join(RUN, "queues.json");
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
}

/** A message in a session's inbox, as far as the queue reads it. */
interface InboxEntry {
  id: string;
  delivery: "steer" | "queue";
}

const keptState = (value: unknown): QueueState => ({
  paused: isObject(value) && value.paused === true,
  held: isObject(value) && Array.isArray(value.held) ? value.held.filter((id): id is string => typeof id === "string") : [],
  ...(isObject(value) && typeof value.resumed === "number" ? { resumed: value.resumed } : {}),
});

/** A queue as a client reads it. */
export const shownQueue = ({ paused, held }: QueueState): QueueState => ({ paused, held });
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
    if (made.paused || made.held.length || (made.resumed && Date.now() - made.resumed < RESUMED_FOR)) all[session] = made;
    else delete all[session];
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

/** `session`'s next waiting message started, unless its queue is paused or a run is under way: a
 * queued one by steering it (which starts a run), one for the next step by resuming. */
export async function drain(target: Target, session: string): Promise<void> {
  if (queueOf(session).paused || (await isRunning(target, session))) return;
  const next = nextOf(await inboxOf(target, session), queueOf(session).held);
  if (!next) return;
  if (next.delivery === "queue") await setDelivery(target, session, next.id, "steer");
  else await interrupt(target, session, true);
  changeQueue(session, state => ({ ...state, held: state.held.filter(id => id !== next.id) }));
}

/** What waits for `session`'s next step held in its queue, ahead of what was queued (the latest
 * first), and the queue paused when anything waits: what Stop does before it stops the run, and a
 * failed run's. */
// `since`: for an interrupt then (ms), unless Resume or Send Now went on with it after.
export async function holdQueue(target: Target, session: string, since?: number): Promise<QueueState> {
  const resumedSince = () => since !== undefined && (queueOf(session).resumed ?? 0) >= since;
  const inbox = await inboxOf(target, session);
  if (resumedSince()) return queueOf(session);
  const held = queueOf(session).held;
  const steering = inbox.filter(item => item.delivery === "steer" && !held.includes(item.id)).map(item => item.id);
  for (const id of steering) await setDelivery(target, session, id, "queue").catch(() => {});
  return changeQueue(session, state => (since !== undefined && (state.resumed ?? 0) >= since ? state
    : { ...state, paused: state.paused || inbox.length > 0, held: [...steering, ...state.held] }));
}

/** Stop: what waits held and paused, then the run stopped. */
export async function stopSession(target: Target, session: string): Promise<QueueState> {
  const state = await holdQueue(target, session);
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
  data?: { sessionID?: string; inboxID?: string; item?: { delivery?: string }; reason?: string };
}

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
 * One delivered or taken back leaves what's held; nothing left waiting, nothing's paused. */
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
        later(drains, session, () => drain(target, session));
        break;
      case "session.execution.interrupted": {
        if (event.data?.reason === "superseded" || event.data?.reason === "inactivity") {
          later(drains, session, () => drain(target, session));
          break;
        }
        // (Not when it was resumed since: Resume or Send Now goes on.)
        const at = Date.now();
        later(stops, session, async () => {
          if (!(await isRunning(target, session))) await holdQueue(target, session, at);
        });
        break;
      }
      case "session.execution.failed":
        holdQueue(target, session).catch(() => {});
        break;
      case "session.inbox.enqueued":
        if (event.data?.item?.delivery === "steer") changeQueue(session, state => ({ ...state, paused: false }));
        else if (!queueOf(session).paused) later(drains, session, () => drain(target, session));
        break;
      case "session.inbox.delivered":
      case "session.inbox.cancelled": {
        const gone = event.data?.inboxID;
        if (!queueOf(session).paused && !queueOf(session).held.length) break;
        inboxOf(target, session).then(inbox => changeQueue(session, state => ({
          paused: state.paused && inbox.length > 0,
          held: state.held.filter(id => id !== gone && inbox.some(item => item.id === id)),
        }))).catch(() => {});
        break;
      }
    }
  };
}

// The engine (or the agents' bridge) each queue was last looked over for, by its port: a queue left
// with nothing running once it started again waits for Resume, rather than starting on its own.
const scanned = new Map<number, number | undefined>();

/** Once for each engine started anew (its process changed): each of its latest sessions with
 * messages waiting and nothing running held and paused, as Stop holds them. A stream that only
 * dropped and came back carries on. */
export async function scanQueues(target: Target & { pid?: number }): Promise<void> {
  if (scanned.has(target.port) && scanned.get(target.port) === target.pid) return;
  scanned.set(target.port, target.pid);
  const page = await asked(target, "GET", "api/session?parentID=null&limit=100&order=desc") as { data?: { id?: string; time?: { updated?: number } }[] } | null;
  const week = Date.now() - 7 * 86_400_000;
  for (const session of page?.data ?? []) {
    if (typeof session.id !== "string" || (session.time?.updated ?? 0) < week) continue;
    try {
      if ((await inboxOf(target, session.id)).length && !(await isRunning(target, session.id))) await holdQueue(target, session.id);
    } catch {}
  }
}

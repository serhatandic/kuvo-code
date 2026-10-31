// The box's queues as its files keep them (PROTOCOL.md, "The queue"), for every part of the box
// that sends into a conversation on its own: the link (`link/engine/queue.ts`, which carries the
// queues on) and the coding agents' bridge (a group chat's part, to a bot's own conversation). Kept
// in the box's run folder: `queues.json`, by session, and what waits whole in `waiting/<id>.json`,
// changed one process at a time. A client following the queues sees another process's change at
// its next look (`followed`).

import fs from "node:fs";
import path from "node:path";
import { isObject } from "./json";
import { locked, writePrivate } from "./files";

/** Where a box keeps its queues: its run folder's. */
export interface QueueFiles {
  file: string;
  /** What waits on the box for a paused conversation, whole, as it goes to the engine: `<message id>.json`. */
  waiting: string;
  lock: string;
}

export const queueFiles = (run: string): QueueFiles => ({
  file: path.join(run, "queues.json"),
  waiting: path.join(run, "waiting"),
  lock: path.join(run, ".queues.lock"),
});

/** A session's queue as the box keeps it: whether it waits for Resume, and what goes first, in its
 * order (ahead of the queue): what Stop held for the next step, and one Undo put back where it was
 * (in the engine, or waiting on the box). */
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

/** How a message waiting on the box is shown and kept: who it's from, what it says as clients show
 * it, and what goes instead of its text once it waits (a letter whose sender stops waiting). */
export interface Shown {
  from?: string;
  words?: string;
  kept?: string;
}

// (A message's id names its file in `waiting`.)
const WAITING_ID = /^msg_[A-Za-z0-9]{1,80}$/;

/** What waits on the box, as a list in a file (or another box's move) gives it: each that's whole. */
export const keptWaiting = (value: unknown): Waiting[] => (Array.isArray(value) ? value : []).flatMap(item => {
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

/** Whether a client is shown it (`kuvo/sessions/queues/events`): paused, or holding something. */
export const showsQueue = (state: QueueState) => state.paused || state.held.length > 0 || Boolean(state.waiting?.length);
const RESUMED_FOR = 60_000;

/** Every session's queue the box keeps (one that's neither paused nor holds anything isn't kept). */
export function readQueues(files: QueueFiles): Record<string, QueueState> {
  let all: unknown = {};
  try { all = JSON.parse(fs.readFileSync(files.file, "utf8")); } catch {}
  return isObject(all) ? Object.fromEntries(Object.entries(all).map(([session, state]) => [session, keptState(state)])) : {};
}

/** `session`'s queue as `change` makes it, read again just before, under its lock; `changed`, told
 * once it's written. */
export function changeQueue(files: QueueFiles, session: string, change: (state: QueueState) => QueueState, changed?: () => void): QueueState {
  let made = false;
  const after = locked(files.lock, () => {
    const all = readQueues(files);
    const before = all[session] ?? { paused: false, held: [] };
    const state = keptState(change(before));
    state.held = [...new Set(state.held)];
    made = JSON.stringify(state) !== JSON.stringify(before);
    if (!made) return state;
    all[session] = state;
    // Kept while it's paused, holds something, or was resumed a moment ago.
    for (const [id, each] of Object.entries(all)) {
      if (each.resumed && Date.now() - each.resumed >= RESUMED_FOR) delete each.resumed;
      if (!showsQueue(each) && !each.resumed) delete all[id];
    }
    try { writePrivate(files.file, JSON.stringify(all)); } catch {}
    return state;
  });
  if (made) changed?.();
  return after;
}

export const waitingFile = (files: QueueFiles, id: string) => path.join(files.waiting, `${id}.json`);

// The names of the files a message carries, as clients show them.
const fileNames = (files: unknown[] | undefined): string[] => (files ?? []).flatMap(file => {
  if (!isObject(file)) return [];
  if (typeof file.name === "string" && file.name) return [file.name];
  return typeof file.uri === "string" && !file.uri.startsWith("data:") ? [path.basename(decodeURIComponent(file.uri.replace(/^file:\/\//, "")))] : ["file"];
});

/** Where one kept waiting goes in `state` (`waiting` without it): last, unless it's put back where
 * it was (Undo, `link/engine/queue.ts`). */
export type Place = (state: QueueState, item: Waiting) => QueueState;
const last: Place = (state, item) => ({ ...state, waiting: [...(state.waiting ?? []), item] });

/** `message` kept on the box while `session`'s queue is paused (see `Shown`), where `place` puts
 * it: true. Not paused, false: it isn't kept. `changed`: as `changeQueue`'s. */
export function keepWaiting(files: QueueFiles, session: string, message: Outgoing & { id: string }, { from, words, kept: keptText }: Shown = {}, changed?: () => void, place: Place = last): boolean {
  let kept = false;
  changeQueue(files, session, state => {
    if (!state.paused) return state;
    writePrivate(waitingFile(files, message.id), JSON.stringify(keptText === undefined ? message : { ...message, text: keptText }));
    kept = true;
    const names = fileNames(message.files);
    const waiting: Waiting = { id: message.id, ...(from ? { from } : {}), text: words ?? message.text, ...(names.length ? { files: names } : {}), at: Date.now() };
    return place({ ...state, waiting: (state.waiting ?? []).filter(each => each.id !== message.id) }, waiting);
  }, changed);
  return kept;
}

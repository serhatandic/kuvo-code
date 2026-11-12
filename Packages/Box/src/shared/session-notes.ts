// A session's notes (its metadata), and its rules where a writer changes those with them, written
// by the box one writer at a time per session (#581). The engine (2.2.5) and the coding agents'
// bridge keep what a PATCH sends whole, with nothing to say "only if unchanged": a writer reads the
// session, changes it and sends it all back, so two at once lose one's change. Here each writer
// takes its turn on the session (in its process, and across this computer's box processes and its
// bridge, by a lock folder in the box's `run/notes`), reads it as it is then, changes only what it
// owns, and writes it straight away. What can still be lost: a write by a client that doesn't come
// through the box, landing between that read and that write (PROTOCOL.md, "Session notes").

import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { lockedWhile } from "./files";
import { isObject } from "./json";
import { sleep } from "./wait";

/** What a writer sends (each as the place keeps it: whole). */
export interface SessionChange {
  metadata?: Record<string, unknown>;
  permissions?: unknown[];
}

/** `work` done holding session `id`'s turn across processes too. */
export type Across = <T>(id: string, work: () => Promise<T>) => Promise<T>;

/** A place's sessions (the engine, or the coding agents' bridge), as a writer reads and writes one. */
export interface NotesPlace<S> {
  /** Which place it is: writers to the same place and session take turns. */
  name: string;
  /** The session as it is now; null where there's none. It throws where the place can't say. */
  read(id: string, signal: AbortSignal): Promise<S | null>;
  /** `change` sent to the session; it throws where the place didn't take it. */
  write(id: string, change: SessionChange, signal: AbortSignal): Promise<unknown>;
  /** `work` done holding the session's turn across this computer's processes too (`lockedIn`). */
  across?: Across;
}

/** How long a turn's read, and its write, may each take: a place that hangs holds no one up for
 * longer. */
export const NOTES_STEP = 30_000;
/** Longer than any turn lasts (a read and a write): a lock folder older than this was left by a
 * process cut off, and another process waits for one this long at most. */
export const NOTES_STALE = 2 * NOTES_STEP + 5_000;

// Each place's and session's turns in this process: the last one's end; and how many are held or
// waited for.
const turns = new Map<string, Promise<void>>();
const counted = new Map<string, number>();
// The turns the work going on now holds: a writer that writes within its own turn never waits on itself.
const holding = new AsyncLocalStorage<ReadonlySet<string>>();

/** How many turns on session `id` on `place` are held or waited for in this process now. */
export const turnsOn = (place: string, id: string): number => counted.get(`${place}\n${id}`) ?? 0;

/** `before`'s end, or `signal`'s stop (it throws then), whichever comes first; nothing left
 * listening on `signal` after. */
const untilOrStopped = (before: Promise<void>, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) return reject(signal.reason);
  const stop = () => reject(signal.reason);
  signal.addEventListener("abort", stop, { once: true });
  before.then(() => {
    signal.removeEventListener("abort", stop);
    resolve();
  });
});

/** `work` done in the turn of session `id` on place `place`: after every one before it in this
 * process (each is cut short at `NOTES_STEP` a read or write), unless `signal` stops it first; with
 * `across`, holding it across processes too. Its turn ends however `work` ends, thrown too. */
export async function inTurn<T>(place: string, id: string, work: () => Promise<T>, across?: Across, signal?: AbortSignal): Promise<T> {
  const key = `${place}\n${id}`;
  const held = holding.getStore();
  if (held?.has(key)) return work();
  const before = turns.get(key) ?? Promise.resolve();
  let done = () => {};
  const ended = new Promise<void>(resolve => { done = resolve; });
  const mine = before.then(() => ended);
  turns.set(key, mine);
  counted.set(key, (counted.get(key) ?? 0) + 1);
  try {
    await (signal ? untilOrStopped(before, signal) : before);
    const run = () => holding.run(new Set([...(held ?? []), key]), work);
    return await (across ? across(id, run) : run());
  } finally {
    done();
    if (turns.get(key) === mine) turns.delete(key);
    const left = (counted.get(key) ?? 1) - 1;
    if (left > 0) counted.set(key, left);
    else counted.delete(key);
  }
}

/** The lock folder for session `id`'s turn in `folder`, the same for every process that names it. */
export const notesLock = (folder: string, id: string): string =>
  path.join(folder, `${crypto.createHash("sha256").update(id).digest("hex").slice(0, 32)}.lock`);

// Where a box before #581 held its one lock for every session's notes, for its `noteSession`: its
// folder, and its own stale time.
const OLD_STALE = 120_000;

/** Waits while a box from before still holds its one lock (`oldLock`), as long as it would have
 * waited for it (half a minute), never taking it: it's that box's, and the new ones keep to a lock
 * per session among themselves. */
async function pastOld(oldLock: string): Promise<void> {
  for (let waited = 0; waited < 30_000; waited += 10) {
    try {
      if (Date.now() - fs.statSync(oldLock).mtimeMs > OLD_STALE) return;
    } catch {
      return;
    }
    await sleep(10);
  }
}

/** Session turns held across this computer's processes by a lock folder each in `folder` (the box's
 * `run/notes`): one left by a process cut off goes once it's older than any turn (`NOTES_STALE`),
 * and another process waits that long at most before it goes ahead. Where the folder can't be made,
 * it goes ahead without. `oldLock`: a box from before's one lock, waited past. */
export function lockedIn(folder: string, oldLock?: string): Across {
  return async (id, work) => {
    try {
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    } catch {
      return work();
    }
    const lock = notesLock(folder, id);
    acrossWaits.set(lock, (acrossWaits.get(lock) ?? 0) + 1);
    let waited = false;
    const started = () => {
      if (waited) return;
      waited = true;
      const left = (acrossWaits.get(lock) ?? 1) - 1;
      if (left > 0) acrossWaits.set(lock, left);
      else acrossWaits.delete(lock);
    };
    try {
      if (oldLock) await pastOld(oldLock);
      return await lockedWhile(lock, () => {
        started();
        return work();
      }, { stale: NOTES_STALE, wait: NOTES_STALE });
    } finally {
      started();
    }
  };
}

// Turns in this process waiting for their lock folder, by folder.
const acrossWaits = new Map<string, number>();

/** How many of this process's turns on session `id` wait for its lock folder in `folder` now. */
export const waitingAcross = (folder: string, id: string): number => acrossWaits.get(notesLock(folder, id)) ?? 0;

/** Lock folders in `folder` older than any turn: left by a process cut off, which nothing takes
 * again (its session gone, say). */
export function clearStaleLocks(folder: string, now = Date.now()): void {
  let names: string[] = [];
  try { names = fs.readdirSync(folder); } catch {}
  for (const name of names) {
    if (!name.endsWith(".lock")) continue;
    const lock = path.join(folder, name);
    try {
      if (now - fs.statSync(lock).mtimeMs > NOTES_STALE) fs.rmdirSync(lock);
    } catch {}
  }
}

/** `signal`, and a stop after `ms`. */
const within = (signal: AbortSignal | undefined, ms: number): AbortSignal =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);

/** A session as a turn left it: whether it was written, and the session as it is now (with what was
 * written). */
export interface Rewritten<S> {
  written: boolean;
  session: S;
}

/**
 * Session `id` on `place` changed in its turn: read as it is then, given to `change`, and what that
 * gives back (null: nothing to change) written at once. `change` changes only what its writer
 * owns, on the session as it was just read, never on one read before. Null where there's no such
 * session; it throws where the place couldn't read it or didn't take the write (and where `change`
 * throws, or `signal` stopped it, waiting for its turn too), its turn ended all the same.
 */
export function rewriteSession<S extends object>(place: NotesPlace<S>, id: string, change: (session: S) => SessionChange | null | undefined, signal?: AbortSignal): Promise<Rewritten<S> | null> {
  return inTurn(place.name, id, async () => {
    const session = await place.read(id, within(signal, NOTES_STEP));
    if (!session) return null;
    const wanted = change(session);
    if (!wanted) return { written: false, session };
    await place.write(id, wanted, within(signal, NOTES_STEP));
    return { written: true, session: { ...session, ...wanted } };
  }, place.across, signal);
}

/** `metadata` with the writer's own notes changed and the rest as they are: `kuvo`'s keys in its
 * `kuvo`, and `top`'s at its top (undefined takes one away). */
export function withNotes(metadata: unknown, kuvo: Record<string, unknown> | null, top: Record<string, unknown> = {}): Record<string, unknown> {
  const notes: Record<string, unknown> = isObject(metadata) ? { ...metadata } : {};
  for (const [key, value] of Object.entries(top)) {
    if (value === undefined) delete notes[key];
    else notes[key] = value;
  }
  if (!kuvo) return notes;
  const own: Record<string, unknown> = isObject(notes.kuvo) ? { ...notes.kuvo } : {};
  for (const [key, value] of Object.entries(kuvo)) {
    if (value === undefined) delete own[key];
    else own[key] = value;
  }
  return { ...notes, kuvo: own };
}

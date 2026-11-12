// A session's notes (its metadata), and its rules where a writer changes those with them, written
// by the box one writer at a time per place and session (#581). The engine (2.2.5) and the coding
// agents' bridge keep what a PATCH sends whole, with nothing to say "only if unchanged": a writer
// reads the session, changes it and sends it all back, so two at once lose one's change. Here
// each writer takes its turn on the session (in this process, and across this computer's box
// processes where its place says how), reads it as it is then, changes only what it owns, and
// writes it straight away. What can still be lost: a write by a client, or by another program
// (the bridge's own writers, for the engine's sessions), landing between that read and that write.

import { AsyncLocalStorage } from "node:async_hooks";
import { isObject } from "./json";

/** What a writer sends (each as the place keeps it: whole). */
export interface SessionChange {
  metadata?: Record<string, unknown>;
  permissions?: unknown[];
}

/** A place's sessions (the engine, or the coding agents' bridge), as a writer reads and writes one. */
export interface NotesPlace<S> {
  /** Which place it is: writers to the same place and session take turns. */
  name: string;
  /** The session as it is now; null where there's none. It throws where the place can't say. */
  read(id: string, signal: AbortSignal): Promise<S | null>;
  /** `change` sent to the session; it throws where the place didn't take it. */
  write(id: string, change: SessionChange, signal: AbortSignal): Promise<unknown>;
  /** `work` done holding the session's turn across this computer's processes too (a lock folder). */
  across?: <T>(id: string, work: () => Promise<T>) => Promise<T>;
}

/** How long a turn's read, and its write, may each take: a place that hangs holds no one up for
 * longer. */
export const NOTES_STEP = 30_000;

// Each place's and session's turns in this process: the last one's end.
const turns = new Map<string, Promise<void>>();
// The turns the work going on now holds: a writer that writes within its own turn never waits on itself.
const holding = new AsyncLocalStorage<ReadonlySet<string>>();

/** `work` done in the turn of session `id` on place `place`: after every one before it in this
 * process, however long they take (each is cut short at `NOTES_STEP` a read or write); with
 * `across`, holding it across processes too. Its turn ends however `work` ends, thrown too. */
export async function inTurn<T>(place: string, id: string, work: () => Promise<T>, across?: <R>(id: string, work: () => Promise<R>) => Promise<R>): Promise<T> {
  const key = `${place}\n${id}`;
  const held = holding.getStore();
  if (held?.has(key)) return work();
  const before = turns.get(key) ?? Promise.resolve();
  let done = () => {};
  const ended = new Promise<void>(resolve => { done = resolve; });
  const mine = before.then(() => ended);
  turns.set(key, mine);
  await before;
  try {
    const run = () => holding.run(new Set([...(held ?? []), key]), work);
    return await (across ? across(id, run) : run());
  } finally {
    done();
    if (turns.get(key) === mine) turns.delete(key);
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
 * throws), its turn ended all the same.
 */
export function rewriteSession<S extends object>(place: NotesPlace<S>, id: string, change: (session: S) => SessionChange | null | undefined, signal?: AbortSignal): Promise<Rewritten<S> | null> {
  return inTurn(place.name, id, async () => {
    const session = await place.read(id, within(signal, NOTES_STEP));
    if (!session) return null;
    const wanted = change(session);
    if (!wanted) return { written: false, session };
    await place.write(id, wanted, within(signal, NOTES_STEP));
    return { written: true, session: { ...session, ...wanted } };
  }, place.across);
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

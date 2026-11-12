// The box's writers of a session's notes on the engine or the coding agents' bridge
// (`../../shared/session-notes.ts`): each in its turn on the session, in this process and across
// this computer's box processes (a client's `box route` beside a phone's) and its bridge, read just
// before it writes, changing only what it owns.

import path from "node:path";
import { clearStaleLocks, inTurn, lockedIn, rewriteSession, type NotesPlace, type Rewritten, type SessionChange } from "../../shared/session-notes";
import { RUN } from "../home";
import { call } from "./client";
import type { EngineSession } from "./sessions";
import type { Target } from "../../shared/records";

/** Where a session's turn is held across processes, while it's held (the bridge holds it there too). */
export const NOTES_LOCKS = path.join(RUN, "notes");
// The one lock a box from before held for every session's notes (`work/.notes.lock`): waited past
// while one runs beside this one, as an update takes over.
const OLD_LOCK = path.join(RUN, "work", ".notes.lock");

const across = lockedIn(NOTES_LOCKS, OLD_LOCK);

const placeName = (target: Target) => `127.0.0.1:${target.port}`;

/** Lock folders left by a process cut off, cleared as the box starts. */
export const clearNotesLocks = (): void => clearStaleLocks(NOTES_LOCKS);

/** `target`'s sessions, as a writer of their notes reads and writes them. */
export function notesPlace(target: Target): NotesPlace<EngineSession> {
  return {
    name: placeName(target),
    read: async (id, signal) => {
      const session = await call(target, "GET", `/api/session/${encodeURIComponent(id)}`, undefined, signal) as EngineSession | null;
      return session?.id ? session : null;
    },
    write: (id, change, signal) => call(target, "PATCH", `/api/session/${encodeURIComponent(id)}`, change, signal),
    across,
  };
}

/** Session `id` on `target` changed in its turn (`rewriteSession`): `change` gets it as it is just
 * before it's written. */
export const rewriteOn = (target: Target, id: string, change: (session: EngineSession) => SessionChange | null | undefined, signal?: AbortSignal): Promise<Rewritten<EngineSession> | null> =>
  rewriteSession(notesPlace(target), id, change, signal);

/** `work` done in session `id`'s turn on `target`: for a write that isn't the box's own (a client's,
 * forwarded), so none of the box's lands between its read and its write. */
export const inTurnOn = <T>(target: Target, id: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> =>
  inTurn(placeName(target), id, work, across, signal);

/** How a session's turn on `target` is named in this process (`turnsOn`). */
export const turnPlace = placeName;

// The box's writers of a session's notes on the engine or the coding agents' bridge
// (`../../shared/session-notes.ts`): each in its turn on the session, in this process and across
// this computer's box processes (a client's `box route` beside a phone's), read just before it
// writes, changing only what it owns.

import crypto from "node:crypto";
import path from "node:path";
import { lockedWhile } from "../../shared/files";
import { inTurn, rewriteSession, type NotesPlace, type Rewritten, type SessionChange } from "../../shared/session-notes";
import { RUN } from "../home";
import { call } from "./client";
import type { EngineSession } from "./sessions";
import type { Target } from "../../shared/records";

/** Where a session's turn is held across processes, while it's held. */
const NOTES_LOCKS = path.join(RUN, "notes");

const placeName = (target: Target) => `127.0.0.1:${target.port}`;

/** Session `id`'s turn on `target`, across this computer's processes: a lock folder for it while
 * it's held (one cut off goes after two minutes; another process waits at most half a minute,
 * as the box's writers always have). */
function across<T>(target: Target, id: string, work: () => Promise<T>): Promise<T> {
  const name = crypto.createHash("sha256").update(`${target.port}\n${id}`).digest("hex").slice(0, 32);
  return lockedWhile(path.join(NOTES_LOCKS, `${name}.lock`), work, { stale: 120_000, wait: 30_000 });
}

/** `target`'s sessions, as a writer of their notes reads and writes them. */
export function notesPlace(target: Target): NotesPlace<EngineSession> {
  return {
    name: placeName(target),
    read: async (id, signal) => {
      const session = await call(target, "GET", `/api/session/${encodeURIComponent(id)}`, undefined, signal) as EngineSession | null;
      return session?.id ? session : null;
    },
    write: (id, change, signal) => call(target, "PATCH", `/api/session/${encodeURIComponent(id)}`, change, signal),
    across: (id, work) => across(target, id, work),
  };
}

/** Session `id` on `target` changed in its turn (`rewriteSession`): `change` gets it as it is just
 * before it's written. */
export const rewriteOn = (target: Target, id: string, change: (session: EngineSession) => SessionChange | null | undefined, signal?: AbortSignal): Promise<Rewritten<EngineSession> | null> =>
  rewriteSession(notesPlace(target), id, change, signal);

/** `work` done in session `id`'s turn on `target`: for a write that isn't the box's own (a client's,
 * forwarded), so none of the box's lands between its read and its write. */
export const inTurnOn = <T>(target: Target, id: string, work: () => Promise<T>): Promise<T> =>
  inTurn(placeName(target), id, work, (session, run) => across(target, session, run));

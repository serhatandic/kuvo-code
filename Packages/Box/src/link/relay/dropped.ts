// Whether the relay dropped a start or a read this box sent another of your computers (PROTOCOL.md,
// "Starts", Sender side). The relay answers what one connection sends in order, and says
// `unreachable` only of something sent: so one that comes for a box while the last thing sent there
// was the call is the call's own, and it never got there. Once anything else is sent there, or this
// connection ends, that can't be told any more: it may have got there. Kept in the link process,
// which sends calls and hears the relay; the tool waiting on the call (on a machine, a process of
// its own) finds a `<id>.dropped` beside the call's outbox file.

import fs from "node:fs";
import { writePrivate } from "../files";

/** Each box's address (base64url) whose last frame from here was a call: that call's outbox file. */
const watched = new Map<string, string>();

/** The mark beside the call in `file` that the relay dropped it. */
export const droppedMark = (file: string): string => file.replace(/\.json$/, ".dropped");

/** Something is being sent to `to` (every frame to an address is made by `relaySend`): a call
 * watched there can't be told from it any more. */
export function sendingTo(to: Buffer): void {
  if (watched.size) watched.delete(to.toString("base64url"));
}

/** The call in `file` was just sent to the box at `to`: watched until something else goes there. */
export function watchCall(to: string, file: string): void {
  watched.set(to, file);
}

/** This box's relay connection ended: nothing sent on it can be told any more. */
export function connectionEnded(): void {
  watched.clear();
}

/** The relay says nothing is connected at `to`: a call watched there was dropped, never got there. */
export function noteDropped(to: Buffer): void {
  const key = to.toString("base64url");
  const file = watched.get(key);
  if (!file) return;
  watched.delete(key);
  if (fs.existsSync(file)) try { writePrivate(droppedMark(file), "{}"); } catch {}
}

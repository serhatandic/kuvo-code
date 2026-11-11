// Whether the relay dropped a start or a read this box sent another of your computers (PROTOCOL.md,
// "Starts", Sender side). The relay answers what one connection sends in order, and says
// `unreachable` only of something sent. Right before the call, a fence goes to this box's own
// address: once it's back, every `unreachable` for what went before has come, so one for that box
// after it, while the call is still the last thing sent there, is the call's own: it never got
// there. Once anything else is sent there, or this connection ends, that can't be told any more: it
// may have got there. Kept in the link process, which sends calls and hears the relay; the tool
// waiting on the call (on a machine, a process of its own) finds a `<id>.dropped` beside the call's
// outbox file.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { writePrivate } from "../files";

const FENCE = Buffer.from("kuvo-fence:");

/** This connection's own address, once welcomed. */
let self: Buffer | null = null;
/** Each box's address (base64url) whose last frame from here was a call: that call's outbox file,
 * its fence, and whether the fence is back. */
const watched = new Map<string, { file: string; fence: string; back: boolean }>();

/** The mark beside the call in `file` that the relay dropped it. */
export const droppedMark = (file: string): string => file.replace(/\.json$/, ".dropped");

/** A relay connection was welcomed at `address`: nothing sent before can be told on it. */
export function connectionStarted(address: Buffer): void {
  watched.clear();
  self = address;
}

/** This box's relay connection ended: nothing sent on it can be told any more. */
export function connectionEnded(): void {
  watched.clear();
  self = null;
}

/** Something is being sent to `to` (every frame to an address is made by `relaySend`): a call
 * watched there can't be told from it any more. */
export function sendingTo(to: Buffer): void {
  if (watched.size) watched.delete(to.toString("base64url"));
}

/** What to send this box's own address right before a call, to fence it off from what went before:
 * its tag, and where and what (null with no connection). */
export function fenceBefore(): { fence: string; to: Buffer; payload: Buffer } | null {
  if (!self) return null;
  const fence = randomBytes(8).toString("hex");
  return { fence, to: self, payload: Buffer.concat([FENCE, Buffer.from(fence)]) };
}

/** The call in `file` was just sent to the box at `to`, right after `fence`: watched until something
 * else goes there. */
export function watchCall(to: string, file: string, fence: string): void {
  watched.set(to, { file, fence, back: false });
}

/** Something sent to this box's own address came back: a fence, every `unreachable` for what went
 * before it come already. */
export function fenceBack(payload: Buffer): void {
  if (payload.length <= FENCE.length || !payload.subarray(0, FENCE.length).equals(FENCE)) return;
  const fence = payload.subarray(FENCE.length).toString();
  for (const each of watched.values()) if (each.fence === fence) each.back = true;
}

/** The relay says nothing is connected at `to`: a call watched there, its fence back, was dropped
 * and never got there. (Before its fence is back, it's of something that went before it.) */
export function noteDropped(to: Buffer): void {
  const key = to.toString("base64url");
  const call = watched.get(key);
  if (!call?.back) return;
  watched.delete(key);
  if (fs.existsSync(call.file)) try { writePrivate(droppedMark(call.file), "{}"); } catch {}
}

// Whether each of your other computers answers now (`run/peer-reach.json`, PROTOCOL.md, "Peers"): the
// relay says a box is unreachable when something sent to it finds nothing connected there, and any
// mail from it says it's back. Kept in a file, not in memory, as a machine's tools are answered by a
// process of their own (`box route`) that has no relay connection to hear it on.

import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { locked, writePrivate } from "../files";
import { RUN } from "../home";
import { readLink } from "../state";
import { peersOf } from "./known";

export const PEER_REACH = path.join(RUN, "peer-reach.json");
const LOCK = path.join(RUN, ".peer-reach.lock");

/** Since when each box that doesn't answer hasn't (ms), by its key; a box that answers isn't in it. */
export function readReach(file = PEER_REACH): Record<string, number> {
  try {
    const kept: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return isObject(kept) ? Object.fromEntries(Object.entries(kept).filter(([, at]) => typeof at === "number")) as Record<string, number> : {};
  } catch {
    return {};
  }
}

const change = (edit: (reach: Record<string, number>) => boolean): void => {
  try {
    fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
    locked(LOCK, () => {
      const reach = readReach();
      if (edit(reach)) writePrivate(PEER_REACH, JSON.stringify(reach));
    });
  } catch {}
};

/** The relay found nothing connected at `address`: the peer there (if it's one) isn't answering, from now. */
export function noteUnreachable(address: Buffer, now = Date.now()): void {
  const peer = peersOf(readLink()).find(each => each.address === address.toString("base64url"));
  if (!peer || readReach()[peer.key] !== undefined) return;
  change(reach => {
    if (reach[peer.key] !== undefined) return false;
    reach[peer.key] = now;
    return true;
  });
}

/** Mail from the box `key`: it answers. True when it didn't before. (Read first, so mail that comes
 * again and again writes nothing.) */
export function noteHeard(key: string): boolean {
  if (readReach()[key] === undefined) return false;
  let back = false;
  change(reach => {
    if (reach[key] === undefined) return false;
    delete reach[key];
    back = true;
    return true;
  });
  return back;
}

/** Since when the box `key` hasn't answered, or null when nothing says it doesn't. */
export const awaySince = (key: string, reach = readReach()): number | null => reach[key] ?? null;

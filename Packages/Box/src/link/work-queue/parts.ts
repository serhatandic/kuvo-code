// Work Queue mail too big for one (PROTOCOL.md, "The Work Queue", "Across your computers"): sent
// in parts, as documents go (`documents/parts`), each a piece of the base64url of the whole's JSON,
// and put together where it arrives.

import crypto from "node:crypto";
import { isObject } from "../../shared/json";
import { assemble, type PendingParts } from "../documents/parts";
import { DOC_PART } from "../documents/format";
import { mailFor } from "../peers/known";
import type { Peer } from "../peers/known";
import type { LinkState } from "../state";

// (More than a document's: an item handed on goes with its files, up to a few MB.)
const MOST_PARTS = 200;

/** `payload` for `peer` (`{workQueue: payload}`) as mails the relay takes: one, or, too big for one,
 * in parts (`{workQueue: {part: {whole, i, of, d, s}}}`, `d` a piece of the base64url of its JSON);
 * null for one too big even so. */
export function mailsFor(peer: Pick<Peer, "key"> & { address?: string }, payload: Record<string, unknown>, link: LinkState, now = Date.now()): Buffer[] | null {
  const one = mailFor(peer, { workQueue: payload, at: now }, link);
  if (one) return [one];
  if (!peer.address) return null;
  const d = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const of = Math.ceil(d.length / DOC_PART);
  if (of > MOST_PARTS) return null;
  const whole = crypto.createHash("sha256").update(d).digest("base64url");
  const mails: Buffer[] = [];
  for (let i = 0; i < of; i++) {
    const bytes = mailFor(peer, { workQueue: { part: { whole, i, of, d: d.slice(i * DOC_PART, (i + 1) * DOC_PART), s: "" } }, at: now }, link);
    if (!bytes) return null;
    mails.push(bytes);
  }
  return mails;
}

// Parts on their way, by sender and whole (a few from each at most).
const pending = new Map<string, PendingParts>();

/** A part of a mail too big for one: the whole mail once its last part is here, else null. */
export function takePart(sender: { key: string }, part: unknown): Record<string, unknown> | null {
  const done = assemble(pending, sender.key, part, MOST_PARTS);
  if (!done) return null;
  try {
    const whole = JSON.parse(Buffer.from(done.d, "base64url").toString("utf8"));
    return isObject(whole) && !isObject(whole.part) ? whole : null;
  } catch {
    return null;
  }
}

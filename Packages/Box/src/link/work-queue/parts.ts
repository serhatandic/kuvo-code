// Work Queue mail too big for one (PROTOCOL.md, "The Work Queue", "Across your computers"): sent
// in parts, each a piece of the base64url of the whole's JSON, and put together where it arrives.

import crypto from "node:crypto";
import { isObject } from "../../shared/json";
import { mailFor } from "../peers/known";
import type { Peer } from "../peers/known";
import type { LinkState } from "../state";

const PART = 40_000;
const MOST_PARTS = 200;
const PART_ID = /^[A-Za-z0-9_-]{20,64}$/;

/** `payload` for `peer` (`{workQueue: payload}`) as mails the relay takes: one, or, too big for one,
 * in parts (`{workQueue: {part: {whole, i, of, d}}}`, `d` a piece of the base64url of its JSON);
 * null for one too big even so. */
export function mailsFor(peer: Pick<Peer, "key"> & { address?: string }, payload: Record<string, unknown>, link: LinkState, now = Date.now()): Buffer[] | null {
  const one = mailFor(peer, { workQueue: payload, at: now }, link);
  if (one) return [one];
  if (!peer.address) return null;
  const d = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const of = Math.ceil(d.length / PART);
  if (of > MOST_PARTS) return null;
  const whole = crypto.createHash("sha256").update(d).digest("base64url");
  const mails: Buffer[] = [];
  for (let i = 0; i < of; i++) {
    const bytes = mailFor(peer, { workQueue: { part: { whole, i, of, d: d.slice(i * PART, (i + 1) * PART) } }, at: now }, link);
    if (!bytes) return null;
    mails.push(bytes);
  }
  return mails;
}

// Parts on their way, by sender and whole: put together once all are here, gone after ten minutes.
const pending = new Map<string, { of: number; parts: (string | undefined)[]; got: number; at: number }>();

/** A part of a mail too big for one: the whole mail once its last part is here, else null. */
export function takePart(sender: { key: string }, part: unknown, now = Date.now()): Record<string, unknown> | null {
  for (const [key, each] of pending) if (now - each.at > 600_000) pending.delete(key);
  if (!isObject(part) || typeof part.whole !== "string" || !PART_ID.test(part.whole) || !Number.isInteger(part.i) || !Number.isInteger(part.of) || typeof part.d !== "string") return null;
  const of = part.of as number, i = part.i as number;
  if (of < 1 || of > MOST_PARTS || i < 0 || i >= of || part.d.length > PART) return null;
  const key = `${sender.key} ${part.whole}`;
  // (At most a few under way from each, so a box can't fill this one's memory: a new one takes the
  // place of its oldest, one a hiccup left unfinished.)
  if (!pending.has(key)) {
    const theirs = [...pending].filter(([each]) => each.startsWith(`${sender.key} `)).sort((a, b) => a[1].at - b[1].at);
    for (const [old] of theirs.slice(0, Math.max(0, theirs.length - 5))) pending.delete(old);
  }
  const kept = pending.get(key) ?? { of, parts: new Array<string | undefined>(of).fill(undefined), got: 0, at: now };
  if (kept.of !== of) return null;
  if (kept.parts[i] === undefined) {
    kept.parts[i] = part.d;
    kept.got++;
  }
  pending.set(key, kept);
  if (kept.got < of) return null;
  pending.delete(key);
  const d = kept.parts.join("");
  if (crypto.createHash("sha256").update(d).digest("base64url") !== part.whole) return null;
  try {
    const whole = JSON.parse(Buffer.from(d, "base64url").toString("utf8"));
    return isObject(whole) && !isObject(whole.part) ? whole : null;
  } catch {
    return null;
  }
}


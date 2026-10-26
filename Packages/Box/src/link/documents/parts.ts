// @ts-nocheck
// What's too big for one mail (a document, a group chat's seat): sent in parts, and put together here.

import crypto from "node:crypto";
import { isObject } from "../../shared/json";
import { DOC_PART, MOST_PARTS } from "./format";

// A document too big for one mail comes in parts (`{whole, i, of, d, s}`: `whole`, its `d`'s hash),
// put together here, at most four on their way from one box at a time. The document once all are
// here, or null.
export function assemble(parts, from, part) {
  if (!isObject(part) || typeof part.whole !== "string" || !Number.isInteger(part.i) || !Number.isInteger(part.of) || part.of < 2 || part.of > MOST_PARTS
    || part.i < 0 || part.i >= part.of || typeof part.d !== "string" || part.d.length > DOC_PART || typeof part.s !== "string") return null;
  const key = `${from} ${part.whole}`;
  let pending = parts.get(key);
  if (!pending || pending.of !== part.of) {
    const theirs = [...parts.keys()].filter(each => each.startsWith(`${from} `));
    if (theirs.length >= 4) parts.delete(theirs[0]);
    pending = { of: part.of, s: part.s, pieces: new Map() };
    parts.set(key, pending);
  }
  pending.pieces.set(part.i, part.d);
  if (pending.pieces.size < part.of) return null;
  parts.delete(key);
  const d = Array.from({ length: part.of }, (_, i) => pending.pieces.get(i)).join("");
  if (crypto.createHash("sha256").update(d).digest("base64url") !== part.whole) return null;
  return { d, s: pending.s };
}

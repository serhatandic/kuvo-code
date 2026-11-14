// What's too big for one mail (a document, a group chat's seat): sent in parts, and put together here.

import crypto from "node:crypto";
import { isObject } from "../../shared/json";
import { DOC_PART, MOST_PARTS } from "./format";

/** A part of a document, as a mail brings it: `whole`, the hash of the document's `d`; part `i` of `of`; its piece of `d`; the document's `s`. */
export interface DocPart {
  whole: string;
  i: number;
  of: number;
  d: string;
  s: string;
}

/** A document's parts on their way from one box: how many it comes in, its `s`, and the pieces so far by number. */
export interface PendingParts {
  of: number;
  s: string;
  pieces: Map<number, string>;
}

/** A document put together from its parts. */
export interface AssembledDoc {
  d: string;
  s: string;
}

// Whatever a mail brings as a part, checked as one (`DocPart`, as it's sent), of `most` at most.
const fitsPart = (part: unknown, most: number): part is DocPart => isObject(part) && typeof part.whole === "string" && Number.isInteger(part.i) && Number.isInteger(part.of)
  && (part.of as number) >= 2 && (part.of as number) <= most && (part.i as number) >= 0 && (part.i as number) < (part.of as number)
  && typeof part.d === "string" && part.d.length <= DOC_PART && typeof part.s === "string";

// A document too big for one mail comes in parts (`{whole, i, of, d, s}`: `whole`, its `d`'s hash),
// put together here, at most four on their way from one box at a time. The document once all are
// here, or null. (`most`: how many parts one may come in; the Work Queue's mail, `work-queue/parts`,
// comes in more.)
export function assemble(parts: Map<string, PendingParts>, from: string, part: unknown, most = MOST_PARTS): AssembledDoc | null {
  if (!fitsPart(part, most)) return null;
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
  const d = Array.from({ length: part.of }, (_, i) => pending!.pieces.get(i)).join("");
  if (crypto.createHash("sha256").update(d).digest("base64url") !== part.whole) return null;
  return { d, s: pending.s };
}

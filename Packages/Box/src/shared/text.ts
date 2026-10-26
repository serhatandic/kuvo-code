// Text as the apps show it and as the box writes it: names and lines, cut to fit, dates, ids, and
// words for a shell.

import crypto from "node:crypto";

// On one line, cut to `limit` characters, as the Mac lists a machine's.
export const oneLine = (text: unknown, limit: number) => Array.from(String(text).replace(/[\t\r\n]/g, " ")).slice(0, limit).join("");
// As Swift writes dates: to the second.
export const stamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
/** A new id: `prefix` and twenty letters and digits (`bot_…`, `grp_…`). */
export const newID = (prefix: string) => prefix + Array.from(crypto.randomBytes(10), byte => "abcdefghijklmnopqrstuvwxyz0123456789"[byte % 36]).join("");
// A name as one line of plain text, as the Mac's name field has it.
export const plainName = (text: unknown) => String(text ?? "").replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, " ").split(/\s+/).filter(Boolean).join(" ");

// The characters of `text` that fit in `bytes` of UTF-8.
export function prefixBytes(text: string, bytes: number) {
  let out = "", count = 0;
  for (const character of text) {
    count += Buffer.byteLength(character);
    if (count > bytes) break;
    out += character;
  }
  return out;
}
/** `text` at most `count` UTF-16 units, ending in "…" when it's cut. */
export const cut = (text: string, count: number) => text.length <= count ? text : text.slice(0, count - 1) + "…";
/** `text` as one word for sh, in single quotes. */
export const quote = (text: unknown) => `'${String(text).replace(/'/g, `'\\''`)}'`;

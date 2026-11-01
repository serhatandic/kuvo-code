// Text as the apps show it and as the box writes it: names and lines, cut to fit, dates, ids, and
// words for a shell.

import crypto from "node:crypto";

// How much of a text file attached to a message the coding agents get in it, as the agents' bridge
// puts it in; a bigger one goes by its path, for the agent to open.
export const AGENTS_TEXT_BYTES = 200_000;

// On one line, cut to `limit` characters, as the Mac lists a machine's.
export const oneLine = (text: unknown, limit: number) => Array.from(String(text).replace(/[\t\r\n]/g, " ")).slice(0, limit).join("");
// As Swift writes dates: to the second.
export const stamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
/** A new id: `prefix` and twenty letters and digits (`bot_…`, `grp_…`). */
export const newID = (prefix: string) => prefix + Array.from(crypto.randomBytes(10), byte => "abcdefghijklmnopqrstuvwxyz0123456789"[byte % 36]).join("");
// A name as one line of plain text, as the Mac's name field has it.
export const plainName = (text: unknown) => String(text ?? "").replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ").split(/\s+/).filter(Boolean).join(" ");

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
/** A folder or file an agent asks to work in outside its project, as people know it (as the apps'
 * ClientText `OutsideFolders.shown` has it): "~/notes" for "<home>/notes/*", "/" for the whole disk,
 * "Any folder" for "*"; a path elsewhere whole. */
export function outsideShown(pattern: string, home: string | null): string {
  let path = pattern.trim();
  if (path === "*" || path === "**") return "Any folder";
  for (const glob of ["/**", "/*"]) if (path.endsWith(glob)) { path = path.slice(0, -glob.length) || "/"; break; }
  while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  const own = home?.replace(/(?<=.)\/+$/, "");
  const rest = path === "~" ? "" : path.startsWith("~/") ? path.slice(2) : own && path === own ? "" : own && path.startsWith(own + "/") ? path.slice(own.length + 1) : null;
  return rest === null ? path : rest ? `~/${rest}` : "~";
}

/** `text` at most `count` UTF-16 units, ending in "…" when it's cut. */
export const cut = (text: string, count: number) => text.length <= count ? text : text.slice(0, count - 1) + "…";
/** `text` as one word for sh, in single quotes. */
export const quote = (text: unknown) => `'${String(text).replace(/'/g, `'\\''`)}'`;

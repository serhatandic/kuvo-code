// How a path the box moved is written anew (#333 §3.4): one path map (old prefix → new, longest
// first) applied by these, whatever shape the path is kept in. A move back is the same map turned
// around.

import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Placement } from "./state";

/** One old prefix and the new one it becomes, longest first. */
export type PathMap = { from: string; to: string }[];

/** The path map of a plan: each placement's folder to where it goes, the longest first (a folder
 * inside another moved apart from it goes by its own). */
export function pathMap(placements: readonly Placement[], root?: { from: string; to: string }): PathMap {
  const seen = new Set<string>();
  return [...placements.filter(each => !each.installed).map(each => ({ from: each.from, to: each.to })), ...(root ? [root] : [])]
    .filter(each => !seen.has(each.from) && seen.add(each.from))
    .sort((a, b) => b.from.length - a.from.length);
}

/** `file` as the map has it, or as it was where nothing maps it. */
export function mapped(file: string, map: PathMap): string {
  for (const { from, to } of map) {
    if (file === from) return to;
    if (file.startsWith(from + "/")) return to + file.slice(from.length);
  }
  return file;
}

/** Whether the map moves `file`. */
export const moves = (file: string, map: PathMap): boolean => mapped(file, map) !== file;

/** A `file://` URL as the map has it: written as it was (its folder's spaces as they are, or as
 * `%20`), or null where it isn't one the map moves. */
export function mappedURL(url: string, map: PathMap): string | null {
  if (!url.startsWith("file://")) return null;
  let file: string;
  try { file = fileURLToPath(url); } catch { return null; }
  const to = mapped(file, map);
  if (to === file) return null;
  // (Kept as the client sent it: the old prefix written plainly, or encoded.)
  for (const { from } of map) {
    if (file !== from && !file.startsWith(from + "/")) continue;
    const rest = url.slice("file://".length);
    const encoded = pathToFileURL(from).href.slice("file://".length);
    // (Where both forms read the same, `~/.kuvo-code`'s, which it was isn't known: encoded, as a URL is.)
    const plain = encoded !== from && rest.startsWith(from) && (rest.length === from.length || rest[from.length] === "/" || rest[from.length] === "?" || rest[from.length] === "#");
    if (plain) return "file://" + mapped(from, map) + rest.slice(from.length);
    if (rest.startsWith(encoded)) return "file://" + pathToFileURL(mapped(from, map)).href.slice("file://".length) + rest.slice(encoded.length);
    break;
  }
  return pathToFileURL(to).href;
}

/** A string as the map has it, where it's a path, a `file://` URL or an engine setting's
 * `{file:…}`; anything else (text with a path in it among other words) as it is, or null where
 * nothing changes. */
export function mappedValue(value: string, map: PathMap): string | null {
  if (value.includes("\n")) return null;
  const url = mappedURL(value, map);
  if (url !== null) return url;
  const setting = /^\{file:(.+)\}$/.exec(value);
  if (setting) {
    const to = mapped(setting[1], map);
    return to === setting[1] ? null : `{file:${to}}`;
  }
  if (!path.isAbsolute(value)) return null;
  const to = mapped(value, map);
  return to === value ? null : to;
}

/** Every string in a JSON value that's a path the map moves, written anew (each key too, as some
 * lists are kept by their folders); how many changed. */
export function mapJSON(value: unknown, map: PathMap): { value: unknown; changed: number } {
  let changed = 0;
  const walk = (each: unknown): unknown => {
    if (typeof each === "string") {
      const to = mappedValue(each, map);
      if (to === null) return each;
      changed++;
      return to;
    }
    if (Array.isArray(each)) return each.map(walk);
    if (each && typeof each === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(each)) {
        const to = mappedValue(key, map);
        if (to !== null) changed++;
        out[to ?? key] = walk(inner);
      }
      return out;
    }
    return each;
  };
  const result = walk(value);
  return { value: result, changed };
}

/** Text whose lines name paths (a git link, an alternates file, git's settings): each old prefix
 * where it starts a path (after a line's start, a space, `=`, `:` or a quote) and ends one (before
 * a slash, a line's end or a quote), written anew. */
export function mapLines(text: string, map: PathMap): string {
  if (!map.length) return text;
  // (One pass, the longest prefix first: what's written anew is never mapped again.)
  const escaped = map.map(({ from }) => from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return text.replace(new RegExp(`(^|[\\s=:"'])(${escaped})(?=$|[/"'\\r\\n])`, "gm"), (_, before: string, from: string) => before + mapped(from, map));
}

/** Whether `text` names an old path still: where the map's old prefix starts a path. */
export function namesOld(text: string, map: PathMap): boolean {
  return map.some(({ from }) => {
    for (const form of [from, pathToFileURL(from).href.slice("file://".length)]) {
      let at = text.indexOf(form);
      while (at >= 0) {
        const after = text[at + form.length];
        if (after === undefined || after === "/" || after === "\"" || after === "'" || after === "\n" || after === "\r" || after === "}" || after === "\\" || after === "?" || after === "#") return true;
        at = text.indexOf(form, at + 1);
      }
    }
    return false;
  });
}

const sha1 = (text: string) => createHash("sha1").update(text).digest("hex");

/** The engine's ID for a project in a folder outside git: by its folder's path (`sha1("directory:" + path)`). */
export const folderProjectID = (folder: string): string => sha1(`directory:${folder}`);

/** The name of the engine's snapshot history for a worktree (`snapshot/<project>/<sha1(path)>`). */
export const snapshotName = (folder: string): string => sha1(folder);

/** The name Claude Code gives a folder's history (`projects/<slug>`): every character but a letter or
 * digit a hyphen, and one longer than 200 cut there, with a sum of its own (its 32-bit string hash,
 * in base 36), as Claude Code 2.1's `projects` does. */
export function claudeSlug(folder: string): string {
  const slug = folder.replace(/[^a-zA-Z0-9]/g, "-");
  if (slug.length <= 200) return slug;
  let sum = 0;
  for (let i = 0; i < folder.length; i++) sum = (sum << 5) - sum + folder.charCodeAt(i) | 0;
  return `${slug.slice(0, 200)}-${Math.abs(sum).toString(36)}`;
}

/** The Keychain item Claude Code keeps an account's sign-in in, for one in its own folder
 * (`CLAUDE_CONFIG_DIR`): by the folder's path, NFC, as Claude Code names it. */
export const claudeKeychainService = (folder: string): string =>
  `Claude Code-credentials-${createHash("sha256").update(folder.normalize("NFC")).digest("hex").slice(0, 8)}`;

/** Grok's folder for its sessions in a folder (`sessions/<URL-encoded path>`). */
export const grokSessionsName = (folder: string): string => encodeURIComponent(folder);

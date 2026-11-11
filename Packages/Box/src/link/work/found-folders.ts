// Where each of a conversation's own folders was first found to be (PROTOCOL.md, "Auto's
// reviewer"): as the box first sees a conversation, or a folder made to be its own (a project an
// agent makes), else as it's first looked at, kept in the box's folder across restarts. One traded
// for a link to elsewhere since (by a command in it) doesn't take its files with it.

import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { writePrivate } from "../files";
import { BOX } from "../home";
import { askedAbout } from "../fence/policy";

const FOUND_FILE = path.join(BOX, "found-folders.json");
const MOST_FOUND = 2000;
let firstFound: Map<string, string> | null = null;
function foundFolders(): Map<string, string> {
  if (firstFound) return firstFound;
  firstFound = new Map();
  try {
    const kept = JSON.parse(fs.readFileSync(FOUND_FILE, "utf8"));
    if (isObject(kept)) for (const [folder, real] of Object.entries(kept)) if (typeof real === "string" && path.isAbsolute(real)) firstFound.set(folder, real);
  } catch {}
  return firstFound;
}
function keepFound(folder: string, real: string): void {
  const found = foundFolders();
  if (found.get(folder) === real) return;
  found.delete(folder);
  found.set(folder, real);
  while (found.size > MOST_FOUND) found.delete(found.keys().next().value!);
  try { writePrivate(FOUND_FILE, JSON.stringify(Object.fromEntries(found))); } catch {}
}
export function foundAt(folder: string): string {
  const known = foundFolders().get(folder);
  if (known !== undefined) return known;
  const real = realPath(folder);
  keepFound(folder, real);
  return real;
}

/** A conversation's folder as the box first sees it (as it's made, or adopted): where it really is
 * then is where its own is, whatever it's traded for later. */
export async function noteFolderFound(folder: unknown): Promise<void> {
  if (typeof folder !== "string" || !path.isAbsolute(folder) || foundFolders().has(folder)) return;
  await askedAbout([folder]);
  keepFound(folder, realPath(folder));
}

/** Where `file` really is, as far as it's there: the folder that is, its links followed, and the
 * rest as named. */
function realPath(file: string): string {
  const rest: string[] = [];
  for (let at = path.resolve(file); ; ) {
    try {
      return path.join(fs.realpathSync(at), ...rest.reverse());
    } catch {
      const up = path.dirname(at);
      if (up === at) return path.resolve(file);
      rest.push(path.basename(at));
      at = up;
    }
  }
}

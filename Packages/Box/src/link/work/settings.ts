// Where new projects go on this box (PROTOCOL.md, "Work"): a folder you pick once per computer,
// kept in `box/work.json` as `projectsFolder`; none until you pick one. A project is your work, not
// Kuvo Code's, so it goes where you choose, and the box makes projects only there.

import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { textOf, writePrivate } from "../files";
import { BOX, homeFolder } from "../home";

export const WORK_SETTINGS_FILE = path.join(BOX, "work.json");

const isFolder = (folder: string) => {
  try {
    return fs.statSync(folder).isDirectory();
  } catch {
    return false;
  }
};

/** The folder new projects go in here, or null until you pick one (or once it's gone). */
export function projectsFolder(file = WORK_SETTINGS_FILE): string | null {
  try {
    const kept = JSON.parse(textOf(file) ?? "");
    const folder = isObject(kept) && typeof kept.projectsFolder === "string" ? kept.projectsFolder : null;
    return folder && path.isAbsolute(folder) && isFolder(folder) ? folder : null;
  } catch {
    return null;
  }
}

/** The folder to offer when none is picked: ~/Developer or ~/Projects, if there's one. */
export function suggestedFolder(home = homeFolder()): string | null {
  return ["Developer", "Projects", "projects", "dev", "code"].map(name => path.join(home, name)).find(isFolder) ?? null;
}

/** `given` (written with `~` or in full) as a projects folder, or why it can't be one. */
export function folderGiven(given: unknown): { folder: string } | { refused: string } {
  if (typeof given !== "string" || !given.trim()) return { refused: "Say which folder (projectsFolder), as a full path." };
  const written = given.trim().replace(/^~(?=$|\/)/, homeFolder());
  if (!path.isAbsolute(written)) return { refused: "Give a full path to the folder." };
  const folder = path.resolve(written);
  if (!isFolder(folder)) return { refused: `There's no folder at ${given.trim()}.` };
  return { folder };
}

/** `given` as the projects folder (null for none), or why it can't be. */
export function setProjectsFolder(given: unknown, file = WORK_SETTINGS_FILE): { folder: string | null } | { refused: string } {
  if (given === null) {
    writeSettings({ projectsFolder: null }, file);
    return { folder: null };
  }
  const checked = folderGiven(given);
  if ("refused" in checked) return checked;
  writeSettings({ projectsFolder: checked.folder }, file);
  return checked;
}

function writeSettings(change: Record<string, unknown>, file: string) {
  let kept: Record<string, unknown> = {};
  try {
    const read = JSON.parse(textOf(file) ?? "");
    if (isObject(read)) kept = read;
  } catch {}
  writePrivate(file, JSON.stringify({ ...kept, ...change }, null, 2));
}

/** The settings as clients read them: the folder (null for none) and, without one, one to offer. */
export function workSettings(file = WORK_SETTINGS_FILE): { projectsFolder: string | null; suggested?: string } {
  const folder = projectsFolder(file);
  const suggested = folder ? null : suggestedFolder();
  return { projectsFolder: folder, ...(suggested ? { suggested } : {}) };
}

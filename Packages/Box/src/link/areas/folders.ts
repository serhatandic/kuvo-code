// @ts-nocheck
// Folders (PROTOCOL.md, `kuvo/folders`): this box's folders, for a client to choose one.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promptedFolders } from "../../shared/platform";

/** `kuvo/folders?path=`: the folders in one of this box's folders (none: the home folder; `~/`
 * starts there), as a client shows them to choose one: `{path, home, parent, folders: [{name,
 * repository?}]}`, ordered as Finder orders names, hidden ones (starting with ".") only with
 * `hidden=1`. `repository`: a git repository's own checkout. */
export function listFolders(requestPath) {
  const query = new URLSearchParams(requestPath.split("?")[1] ?? "");
  const home = os.homedir();
  const given = (query.get("path") ?? "").trim();
  const folder = !given || given === "~" ? home : given.startsWith("~/") ? path.join(home, given.slice(2)) : given;
  if (!path.isAbsolute(folder)) return { status: 400, value: { message: "Send a folder's full path, or one that starts with ~/." } };
  const at = path.resolve(folder);
  let entries;
  try {
    entries = fs.readdirSync(at, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return { status: 404, value: { message: `There's no folder ${at} here.` } };
    return { status: 403, value: { message: `${at} can't be read here.` } };
  }
  const hidden = query.get("hidden") === "1";
  // Platform: on a Mac, looking into these from the home folder would have macOS ask you for them.
  const asks = at === home ? promptedFolders() : new Set();
  const isFolder = entry => entry.isDirectory() || (entry.isSymbolicLink() && (() => { try { return fs.statSync(path.join(at, entry.name)).isDirectory(); } catch { return false; } })());
  const folders = entries
    .filter(entry => (hidden || !entry.name.startsWith(".")) && isFolder(entry))
    .map(entry => (!asks.has(entry.name) && fs.existsSync(path.join(at, entry.name, ".git")) ? { name: entry.name, repository: true } : { name: entry.name }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  return { status: 200, value: { path: at, home, parent: at === path.dirname(at) ? null : path.dirname(at), folders } };
}

/** `POST kuvo/folders {"path"}`: a new folder, in one that's there, as a folder panel's New Folder
 * makes one: `{path}` (`~/` starts at the home folder). */
export function makeFolder(body) {
  const given = typeof body?.path === "string" ? body.path.trim() : "";
  const home = os.homedir();
  const folder = given.startsWith("~/") ? path.join(home, given.slice(2)) : given;
  if (!path.isAbsolute(folder)) return { status: 400, value: { message: "Send the new folder's full path, or one that starts with ~/." } };
  const at = path.resolve(folder);
  // Platform: a Mac's disk usually ignores case, so "Trees" is taken by "trees" there, not on Linux.
  if (fs.existsSync(at)) return { status: 409, value: { message: `There's already something called ${path.basename(at)} there.` } };
  try {
    fs.mkdirSync(at);
  } catch (error) {
    if (error?.code === "ENOENT") return { status: 404, value: { message: `There's no folder ${path.dirname(at)} here.` } };
    return { status: 403, value: { message: `A folder can't be made in ${path.dirname(at)} here.` } };
  }
  return { status: 200, value: { path: at } };
}

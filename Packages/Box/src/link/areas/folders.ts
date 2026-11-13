// Folders (PROTOCOL.md, `kuvo/folders`): this box's folders, for a client to choose one, and every
// file under one (`kuvo/folders/tree`), for a project's file filter and "@".

import fs from "node:fs";
import path from "node:path";
import { gitNamesLater } from "../git";
import { parsed } from "../../shared/json";
import type { Body } from "../../shared/json";
import { promptedFolders } from "../../shared/platform";
import type { AnswerPiece, JSONAnswer, RouteContext } from "../server/context";
import { homeFolder } from "../home";

/** One of this box's folders, as `kuvo/folders` lists it: its path, the home folder, the one it's
 * in (null for the top), the folders in it, and, asked for, its files. */
export interface FolderList {
  path: string;
  home: string;
  parent: string | null;
  folders: { name: string; repository?: boolean }[];
  files?: string[];
}

/** Names as Finder orders them: file3 before file29. */
const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

/** Why a folder can't be listed: what's said, and the computer's own reason, as `ls` would put it. */
export interface FolderRefused {
  message: string;
  reason: string;
}

/** A folder that couldn't be read, by why: 404 for one that isn't there (or isn't a folder), 403
 * for one this box isn't let into, 500 for anything else, each with the reason the system gives. */
export function refusal(at: string, error: unknown): JSONAnswer<FolderRefused> {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") return { status: 404, value: { message: `There's no folder ${at} here.`, reason: "No such folder" } };
  if (code === "ENOTDIR") return { status: 404, value: { message: `${at} isn't a folder.`, reason: "Not a folder" } };
  if (code === "EACCES" || code === "EPERM") return { status: 403, value: { message: `${at} can't be read here.`, reason: "Permission denied" } };
  const said = (error as Error)?.message?.replace(/^[A-Z]+: /, "").split(",")[0]?.trim();
  return { status: 500, value: { message: `${at} can't be read here.`, reason: said ? said[0]!.toUpperCase() + said.slice(1) : "It couldn't be read" } };
}

/** The folder a request's `path` names (none: the home folder; `~/` starts there), or null for one
 * that isn't a full path. */
function askedFolder(query: URLSearchParams, home: string): string | null {
  const given = (query.get("path") ?? "").trim();
  const folder = !given || given === "~" ? home : given.startsWith("~/") ? path.join(home, given.slice(2)) : given;
  return path.isAbsolute(folder) ? path.resolve(folder) : null;
}

/** Every file under one of this box's folders, as a project's file filter and "@" list them. */
export interface FolderTree {
  path: string;
  files: string[];
  git: boolean;
  modified?: (number | null)[];
}

/** How many files a tree lists at most. */
export const TREE_LIMIT = 20_000;
// Folders a walk outside git skips: what builds and installs fill.
const HEAVY = new Set([".git", "node_modules", "build", "DerivedData", ".build", "Pods", "dist", ".next"]);

/** `kuvo/folders/tree?path=`: every file under one of this box's folders (`~/` starts at the home
 * folder), by its path there, at most
 * `limit`: in a repository git's list (tracked and new, without what it ignores, each once, names as
 * they are), `git` true; otherwise, and where git lists nothing there (a folder its repository
 * ignores), a walk that skips the usual heavy folders and doesn't follow links. With `dated=1`,
 * when each last changed (`modified`, milliseconds since 1970, in the same order; null where it
 * can't be read), for a list that puts the newest first. Refused as `kuvo/folders` refuses a
 * folder it can't read. */
export async function listTree(requestPath: string, limit = TREE_LIMIT): Promise<JSONAnswer<FolderTree | FolderRefused | { message: string }>> {
  const query = new URLSearchParams(requestPath.split("?")[1] ?? "");
  const home = homeFolder();
  // (Named, never the home folder by default: a walk of all of it is never what's meant.)
  const at = query.get("path")?.trim() ? askedFolder(query, home) : null;
  if (!at) return { status: 400, value: { message: "Send a folder's full path, or one that starts with ~/." } };
  try {
    await fs.promises.readdir(at);
  } catch (error) {
    return refusal(at, error);
  }
  // Names as they are (git quotes ones with accents, CJK or emoji otherwise), once each (a file in
  // conflict is listed for each side).
  const named = (await gitNamesLater(at, ["-c", "core.quotepath=off", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], limit)) ?? [];
  const dated = query.get("dated") === "1";
  if (named.length) return { status: 200, value: await withDates({ path: at, files: named, git: true }, dated) };
  // Platform: on a Mac, looking into these from the home folder would have macOS ask you for them.
  const asks = at === home ? promptedFolders() : new Set<string>();
  const files: string[] = [];
  const walk = async (inside: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(path.join(at, inside), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= limit) return;
      if (HEAVY.has(entry.name) || (!inside && asks.has(entry.name))) continue;
      const name = inside ? `${inside}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(name);
      else files.push(name);
    }
  };
  await walk("");
  return { status: 200, value: await withDates({ path: at, files, git: false }, dated) };
}

/** `tree` with when each of its files last changed, when `dated`: read a few at a time, so the box
 * goes on answering meanwhile. */
async function withDates(tree: FolderTree, dated: boolean): Promise<FolderTree> {
  if (!dated) return tree;
  const modified: (number | null)[] = new Array(tree.files.length).fill(null);
  for (let at = 0; at < tree.files.length; at += 64) {
    await Promise.all(tree.files.slice(at, at + 64).map(async (name, offset) => {
      try {
        modified[at + offset] = Math.round((await fs.promises.stat(path.join(tree.path, name))).mtimeMs);
      } catch {}
    }));
  }
  return { ...tree, modified };
}

/** `kuvo/folders?path=`: the folders in one of this box's folders (none: the home folder; `~/`
 * starts there), as a client shows them to choose one: `{path, home, parent, folders: [{name,
 * repository?}]}`, ordered as Finder orders names, hidden ones (starting with ".") only with
 * `hidden=1`. `repository`: a git repository's own checkout. With `files=1`, its files too
 * (`files`, names in the same order, `.DS_Store` left out), as a Files panel lists a folder. */
export function listFolders(requestPath: string): JSONAnswer<FolderList | FolderRefused | { message: string }> {
  const query = new URLSearchParams(requestPath.split("?")[1] ?? "");
  const home = homeFolder();
  const at = askedFolder(query, home);
  if (!at) return { status: 400, value: { message: "Send a folder's full path, or one that starts with ~/." } };
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(at, { withFileTypes: true });
  } catch (error) {
    return refusal(at, error);
  }
  const hidden = query.get("hidden") === "1";
  // Platform: on a Mac, looking into these from the home folder would have macOS ask you for them.
  const asks = at === home ? promptedFolders() : new Set<string>();
  const isFolder = (entry: fs.Dirent) => entry.isDirectory() || (entry.isSymbolicLink() && (() => { try { return fs.statSync(path.join(at, entry.name)).isDirectory(); } catch { return false; } })());
  const folders = entries
    .filter(entry => (hidden || !entry.name.startsWith(".")) && isFolder(entry))
    .map(entry => (!asks.has(entry.name) && fs.existsSync(path.join(at, entry.name, ".git")) ? { name: entry.name, repository: true } : { name: entry.name }))
    .sort((a, b) => byName(a.name, b.name));
  const files = query.get("files") === "1"
    ? entries.filter(entry => (hidden || !entry.name.startsWith(".")) && entry.name !== ".DS_Store" && !isFolder(entry)).map(entry => entry.name).sort(byName)
    : undefined;
  return { status: 200, value: { path: at, home, parent: at === path.dirname(at) ? null : path.dirname(at), folders, ...(files ? { files } : {}) } };
}

/** `POST kuvo/folders {"path"}`: a new folder, in one that's there, as a folder panel's New Folder
 * makes one: `{path}` (`~/` starts at the home folder). */
export function makeFolder(body: Body<"path">): JSONAnswer<{ path: string } | { message: string }> {
  const given = typeof body?.path === "string" ? body.path.trim() : "";
  const home = homeFolder();
  const folder = given.startsWith("~/") ? path.join(home, given.slice(2)) : given;
  if (!path.isAbsolute(folder)) return { status: 400, value: { message: "Send the new folder's full path, or one that starts with ~/." } };
  const at = path.resolve(folder);
  // Platform: a Mac's disk usually ignores case, so "Trees" is taken by "trees" there, not on Linux.
  if (fs.existsSync(at)) return { status: 409, value: { message: `There's already something called ${path.basename(at)} there.` } };
  try {
    fs.mkdirSync(at);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { status: 404, value: { message: `There's no folder ${path.dirname(at)} here.` } };
    return { status: 403, value: { message: `A folder can't be made in ${path.dirname(at)} here.` } };
  }
  return { status: 200, value: { path: at } };
}

// Every file under a folder (PROTOCOL.md, `kuvo/folders/tree`).
export async function* folderTreeRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, json } = context;
  if (request.method.toUpperCase() !== "GET") return yield* json(405, {});
  const { status, value } = await listTree(request.path);
  return yield* json(status, value);
}

// A folder of this box's to choose, for a setting that names one (PROTOCOL.md, `kuvo/folders`).
export async function* foldersRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, json } = context;
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "POST") return yield* json(405, {});
  const { status, value } = method === "GET" ? listFolders(request.path) : makeFolder(parsed(request.body) as Body<"path">);
  return yield* json(status, value);
}

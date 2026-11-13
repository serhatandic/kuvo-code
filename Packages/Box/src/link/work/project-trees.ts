// A project's git worktrees, as a conversation's own folders count them (PROTOCOL.md, "Auto's
// reviewer"): a conversation at work in a project's main folder works in its linked worktrees,
// wherever they are (`git worktree add /tmp/try`), as in its own folder. Only the ones its
// repository lists that name it back: each `.git/worktrees/<name>/gitdir` leads to a folder whose
// own `.git` file leads back there, `.git/worktrees` and each entry where they're named (no link to
// another repository's). A command in the sandbox can't move or replace those (on a Mac,
// seatbelt.ts's GIT_GUARDED; on Linux, its namespace's KEEP_GIT in fence/landlock.ts, but where
// commands have none), and the agent's own file tools can anywhere: a pair
// made up so passes only for a folder an agent in Auto could start a session in anyway
// (`keptFromSessions`: never your home, a whole personal folder, your secrets, what runs at login or
// ~/Library), never one of Kuvo Code's, and a change in one is never let through where it's walled
// from a conversation's own (`walledForOwn`), by where the worktree was found, never through a link
// put in its place since (`reviewing.ts`).

import fs from "node:fs";
import path from "node:path";
import { askedAbout } from "../fence/policy";

// Everything here is read off the box's thread (fs.promises), each path macOS may ask about asked
// first (`askedAbout`), and what git keeps read only as a small regular file: a FIFO or a device
// put in its place by a command would hold whoever reads it.
const fsp = fs.promises;
const MOST_READ = 4096;

/** Where `where` really is, its links followed; null where it isn't there. */
async function real(where: string): Promise<string | null> {
  await askedAbout([where]);
  try { return await fsp.realpath(where); } catch { return null; }
}

/** As `realish`, off the box's thread: the deepest folder that's there, its links followed, and
 * the rest as written. */
async function realishLater(where: string): Promise<string> {
  const full = path.resolve(where);
  for (let at = full, rest = ""; ; rest = path.join(path.basename(at), rest), at = path.dirname(at)) {
    const found = await real(at);
    if (found) return path.join(found, rest);
    if (path.dirname(at) === at) return full;
  }
}

/** A small regular file's text (never a FIFO, a device or a link: it's opened without waiting and
 * without following one, and what's opened is what's looked at); null for anything else. */
async function smallFile(file: string): Promise<string | null> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
    const kind = await handle.stat();
    if (!kind.isFile() || kind.size > MOST_READ) return null;
    const buffer = Buffer.alloc(MOST_READ);
    const { bytesRead } = await handle.read(buffer, 0, MOST_READ, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function isRepository(git: string): Promise<boolean> {
  try {
    if ((await fsp.lstat(git)).isSymbolicLink() || !(await fsp.lstat(path.join(git, "HEAD"))).isFile()) return false;
    return (await fsp.stat(path.join(git, "objects"))).isDirectory() && (await fsp.stat(path.join(git, "refs"))).isDirectory();
  } catch {
    return false;
  }
}

/** Where the `gitdir:` line of a worktree's `.git` file leads, by its real path; null for none. */
async function namedBack(top: string): Promise<string | null> {
  const named = (await smallFile(path.join(top, ".git")))?.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
  return named ? real(path.resolve(top, named)) : null;
}

/** The repository `folder` is in, from it upwards: its working folder's top, and the main working
 * folder of its repository (the same for the main one; for a linked worktree, the folder whose
 * `.git` holds it, where it names it back). Null outside any, or in a `.git` that doesn't hold. */
export async function repositoryOf(folder: string): Promise<{ top: string; main: string } | null> {
  for (let at = await realishLater(folder); ; at = path.dirname(at)) {
    const git = path.join(at, ".git");
    let kind: fs.Stats | undefined;
    try { kind = await fsp.lstat(git); } catch {}
    if (kind?.isDirectory()) return await isRepository(git) ? { top: at, main: at } : null;
    if (kind?.isFile()) {
      const own = await namedBack(at);
      if (!own || path.basename(path.dirname(own)) !== "worktrees") return null;
      const common = path.dirname(path.dirname(own));
      if (path.basename(common) !== ".git" || !await isRepository(common)) return null;
      return (await linkedWorktrees(path.dirname(common))).includes(at) ? { top: at, main: path.dirname(common) } : null;
    }
    if (kind || path.dirname(at) === at) return null;
  }
}

/** The linked worktrees of the repository whose main working folder is `main`, by their real
 * paths: each its `.git/worktrees` lists whose folder names it back. Only where `.git/worktrees`
 * and each entry in it are where they're named (never through a link to another repository's). */
export async function linkedWorktrees(main: string): Promise<string[]> {
  const top = await real(main);
  if (!top) return [];
  const git = path.join(top, ".git");
  const trees = path.join(git, "worktrees");
  if (!await isRepository(git) || await real(trees) !== trees) return [];
  let names: string[] = [];
  try { names = await fsp.readdir(trees); } catch { return []; }
  const found: string[] = [];
  for (const name of names) {
    const own = path.join(trees, name);
    try {
      if (!(await fsp.lstat(own)).isDirectory() || await real(own) !== own) continue;
      const gitdir = (await smallFile(path.join(own, "gitdir")))?.trim();
      if (!gitdir) continue;
      const tree = await real(path.dirname(path.resolve(own, gitdir)));
      if (tree && tree !== top && await namedBack(tree) === own) found.push(tree);
    } catch {}
  }
  return found;
}

/** The folders of `folder`'s project in its repository's linked worktrees, where `folder` is in
 * the repository's main working folder (its place in each: a project that's a folder of the
 * repository is that folder in each). None for a folder in a linked worktree, whose own is only
 * itself, nor outside a repository. */
export async function projectWorktrees(folder: string): Promise<string[]> {
  const repository = await repositoryOf(folder);
  if (!repository || repository.top !== repository.main) return [];
  const within = path.relative(repository.top, await realishLater(folder));
  return (await linkedWorktrees(repository.main)).map(tree => path.join(tree, within));
}

/** Whether `folder` is one of `project`'s linked worktrees, or in one, at or below the project's
 * own place there. */
export async function inProjectWorktree(folder: string, project: string): Promise<boolean> {
  const repository = await repositoryOf(folder);
  if (!repository || repository.top === repository.main) return false;
  const mapped = path.join(repository.main, path.relative(repository.top, await realishLater(folder)));
  const home = await realishLater(project);
  return mapped === home || mapped.startsWith(home + "/");
}

/** `work`'s answer, or `instead` once `within` has passed (macOS waiting on you, a slow disk):
 * what's looked up here never holds up what asked for longer. */
export function inTime<T>(work: Promise<T>, instead: T, within = 5_000): Promise<T> {
  return Promise.race([work, new Promise<T>(done => setTimeout(() => done(instead), within).unref?.())]);
}

// Each project's linked worktrees, by the folder its sessions run in there (`worktreeProjects`
// files a session in one under its project, as every client shows it): worked out off the box's
// thread (macOS may ask about a project's folder), again each little while it's asked for, and
// told to those following as it changes. Not one that's a project of its own.
let linked: Record<string, string> = {};
let linkedAt = 0;
let projectsOf: () => string[] = () => [];
const LINKED_FOR = 15_000;
/** Told each time the projects' linked worktrees change. */
export const linkedFollowers = new Set<() => void>();

/** Where the projects whose worktrees are looked for are read from (`areas/projects`). */
export function linkedTreesOf(projects: () => string[]): void {
  projectsOf = projects;
}

/** The projects' linked worktrees as last found: each folder sessions run in there, and its
 * project. Looked for again, off the box's thread, where that was a while ago. */
export function linkedTrees(): Record<string, string> {
  if (Date.now() - linkedAt > LINKED_FOR && !looking) {
    looking = true;
    void findLinkedTrees().finally(() => { looking = false; });
  }
  return linked;
}
let looking = false;
// (One look after another: one asked for now sees the projects as they are now.)
let looks: Promise<void> = Promise.resolve();

/** The projects' linked worktrees, found again now, after any look under way. */
export function findLinkedTrees(): Promise<void> {
  // (Never waiting long on one: macOS asking you about a project's folder, say.)
  const look = () => inTime(lookForTrees(), undefined, 30_000);
  looks = looks.then(look, look);
  return looks;
}

async function lookForTrees(): Promise<void> {
  try {
    const projects = projectsOf();
    const own = new Set(await Promise.all(projects.map(project => inTime(realishLater(project), project))));
    const found: Record<string, string> = {};
    for (const project of projects) {
      for (const tree of await inTime(projectWorktrees(project), [])) if (!own.has(tree)) found[tree] ??= project;
    }
    linkedAt = Date.now();
    if (JSON.stringify(found) === JSON.stringify(linked)) return;
    linked = found;
    for (const tell of linkedFollowers) tell();
  } catch {}
}

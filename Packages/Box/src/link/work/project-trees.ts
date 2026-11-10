// A project's git worktrees, as a conversation's own folders count them (PROTOCOL.md, "Auto's
// reviewer"): a conversation at work in a project's main folder works in its linked worktrees,
// wherever they are (`git worktree add /tmp/try`), as in its own folder. Only the ones its
// repository lists that name it back: each `.git/worktrees/<name>/gitdir` leads to a folder whose
// own `.git` file leads back there. (Neither can a command in the sandbox write: seatbelt.ts's
// GIT_GUARDED; and a folder an agent could only make look like one is the reviewer's, as before.)

import fs from "node:fs";
import path from "node:path";
import { realish } from "../fence/policy";

const real = (where: string): string | null => {
  try { return fs.realpathSync(where); } catch { return null; }
};

const isRepository = (git: string): boolean => {
  try {
    if (fs.lstatSync(git).isSymbolicLink() || !fs.statSync(path.join(git, "HEAD")).isFile()) return false;
    return fs.statSync(path.join(git, "objects")).isDirectory() && fs.statSync(path.join(git, "refs")).isDirectory();
  } catch {
    return false;
  }
};

/** Where the `gitdir:` line of a worktree's `.git` file leads, by its real path; null for none. */
function namedBack(top: string): string | null {
  try {
    if (!fs.lstatSync(path.join(top, ".git")).isFile()) return null;
    const named = fs.readFileSync(path.join(top, ".git"), "utf8").match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
    return named ? real(path.resolve(top, named)) : null;
  } catch {
    return null;
  }
}

/** The repository `folder` is in, from it upwards: its working folder's top, and the main working
 * folder of its repository (the same for the main one; for a linked worktree, the folder whose
 * `.git` holds it, where it names it back). Null outside any, or in a `.git` that doesn't hold. */
export function repositoryOf(folder: string): { top: string; main: string } | null {
  for (let at = realish(folder); ; at = path.dirname(at)) {
    const git = path.join(at, ".git");
    let kind: fs.Stats | undefined;
    try { kind = fs.lstatSync(git); } catch {}
    if (kind?.isDirectory()) return isRepository(git) ? { top: at, main: at } : null;
    if (kind?.isFile()) {
      const own = namedBack(at);
      if (!own || path.basename(path.dirname(own)) !== "worktrees") return null;
      const common = path.dirname(path.dirname(own));
      if (path.basename(common) !== ".git" || !isRepository(common)) return null;
      return linkedWorktrees(path.dirname(common)).includes(at) ? { top: at, main: path.dirname(common) } : null;
    }
    if (path.dirname(at) === at) return null;
  }
}

/** The linked worktrees of the repository whose main working folder is `main`, by their real
 * paths: each its `.git/worktrees` lists whose folder names it back. */
export function linkedWorktrees(main: string): string[] {
  const top = real(main);
  if (!top) return [];
  const git = path.join(top, ".git");
  if (!isRepository(git)) return [];
  let names: string[] = [];
  try { names = fs.readdirSync(path.join(git, "worktrees")); } catch { return []; }
  const found: string[] = [];
  for (const name of names) {
    const own = path.join(git, "worktrees", name);
    try {
      if (fs.lstatSync(own).isSymbolicLink()) continue;
      const gitdir = fs.readFileSync(path.join(own, "gitdir"), "utf8").trim();
      if (!gitdir) continue;
      const tree = real(path.dirname(path.resolve(own, gitdir)));
      if (tree && tree !== top && namedBack(tree) === real(own)) found.push(tree);
    } catch {}
  }
  return found;
}

/** The folders of `folder`'s project in its repository's linked worktrees, where `folder` is in
 * the repository's main working folder (its place in each: a project that's a folder of the
 * repository is that folder in each). None for a folder in a linked worktree, whose own is only
 * itself, nor outside a repository. */
export function projectWorktrees(folder: string): string[] {
  const repository = repositoryOf(folder);
  if (!repository || repository.top !== repository.main) return [];
  const within = path.relative(repository.top, realish(folder));
  return linkedWorktrees(repository.main).map(tree => path.join(tree, within));
}

/** Whether `folder` is one of `project`'s linked worktrees, or in one, at or below the project's
 * own place there. */
export function inProjectWorktree(folder: string, project: string): boolean {
  const repository = repositoryOf(folder);
  if (!repository || repository.top === repository.main) return false;
  const mapped = path.join(repository.main, path.relative(repository.top, realish(folder)));
  const home = realish(project);
  return mapped === home || mapped.startsWith(home + "/");
}

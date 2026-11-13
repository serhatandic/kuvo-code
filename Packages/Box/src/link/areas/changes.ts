// A project's changes on this box, as the Changes panel shows and works them (PROTOCOL.md,
// "Changes"): what git says changed, staging, unstaging and discarding a file, a file as git keeps
// it (a picture's old side), committing and pushing, bringing a branch's work back (Merge into…,
// Create Pull Request), and the repository's branches, switching them, and whether anything isn't
// committed (a branch menu, what Delete says goes with a worktree). A client parses the diff itself; the box runs git, in the box's own
// folders, with the box's git and its settings.

import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { askedArgsLater, ownArgsLater } from "../../shared/git";
import { parsed } from "../../shared/json";
import type { GitBranches, GitChanges, GitChangesCount, GitStatus, PullRequestDraft } from "../../shared/routes/changes";
import { K } from "../home";
import { askedEnv, commandEnv } from "../run-command";
import type { AnswerPiece, RouteContext } from "../server/context";
import { FILE_LIMIT } from "./file";
import { commitPrompt, moveGitSettings, pullRequestPrompt } from "./git-words";
import { readWorktrees } from "./worktree-records";
import { linkPull } from "../glance/pulls";

// git's empty tree: what a repository with no commits yet is compared with.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
// git's settings a client may send along with a commit, which mean the same here: its author.
const AUTHOR = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"];

type Scope = "uncommitted" | "unstaged" | "staged" | "branch";
type Status = "added" | "deleted" | "modified" | "renamed";
const SCOPES: Scope[] = ["uncommitted", "unstaged", "staged", "branch"];
const STATUSES: Status[] = ["added", "deleted", "modified", "renamed"];

interface Ran {
  ok: boolean;
  out: Buffer;
  said: string;
}

/**
 * git in `folder`, never asking anything. Reading takes no locks it needn't, starts nothing the
 * repository's own settings name (`../../shared/git`) and is stopped after ten minutes (stuck on
 * a lock or a hung disk); what changes the repository, which you asked for (a commit with its
 * hooks, a push), takes as long as it takes; `yours`, what runs your hooks and sign-ins (a commit,
 * a push, a merge), with your login shell's environment as it is now (`askedEnv`).
 */
async function git(folder: string, given: string[], changing: boolean | "yours" = false, more: Record<string, string> = {}, program = "git", timeout = 600_000): Promise<Ran> {
  const args = program !== "git" ? given : changing ? await askedArgsLater(given, folder) : await ownArgsLater(given, folder);
  if (!args) return { ok: false, out: Buffer.alloc(0), said: "This repository’s own settings name a program Kuvo Code won’t run for it, or lead git to another repository’s." };
  // Without what only the box's own process should have (Bun's own variables, which would start
  // a hook's `bun build --compile` tool as plain Bun; Kuvo Code's).
  const env = { ...(changing === "yours" ? await askedEnv() : commandEnv()), GIT_TERMINAL_PROMPT: "0", ...(changing ? {} : { GIT_OPTIONAL_LOCKS: "0" }), ...more };
  if (!changing) {
    return new Promise(resolve => {
      execFile(program, args, { cwd: folder, env, encoding: "buffer", maxBuffer: 1024 * 1024 * 1024, timeout }, (error, stdout, stderr) =>
        resolve({ ok: !error, out: stdout ?? Buffer.alloc(0), said: String(stderr ?? "").trim() }));
    });
  }
  // Done when git is: what a hook leaves running (holding its output open) doesn't hold it up.
  return new Promise(resolve => {
    const out: Buffer[] = [];
    const said: Buffer[] = [];
    const child = spawn(program, args, { cwd: folder, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", piece => out.push(piece));
    child.stderr.on("data", piece => said.push(piece));
    child.on("error", () => resolve({ ok: false, out: Buffer.alloc(0), said: `${program} isn’t there.` }));
    child.on("exit", code => setImmediate(() => {
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ ok: code === 0, out: Buffer.concat(out), said: Buffer.concat(said).toString("utf8").trim() });
    }));
  });
}

const text = async (folder: string, args: string[]) => {
  const ran = await git(folder, args);
  return ran.ok ? ran.out.toString("utf8") : null;
};

/** An absolute path to a folder on this box, or null. */
function folderAt(value: unknown): string | null {
  if (typeof value !== "string" || !path.isAbsolute(value)) return null;
  try {
    return fs.statSync(value).isDirectory() ? value : null;
  } catch {
    return null;
  }
}

/** A file's path in a repository, as git names it: relative, never climbing out of it, and
 * never the repository itself ("." or "a//b" aren't one). A repository inside this one is listed
 * as a folder ("web/"), and named without its "/". */
function inRepository(value: unknown): string | null {
  if (typeof value !== "string" || path.isAbsolute(value)) return null;
  const name = value.endsWith("/") ? value.slice(0, -1) : value;
  return name && name.split("/").every(part => part && part !== "." && part !== "..") ? name : null;
}

const realOr = (folder: string) => {
  try {
    return fs.realpathSync(folder);
  } catch {
    return folder;
  }
};

/** Where `directory`'s changes in `scope` are read: its repository's top folder, what they're
 * compared with, the folder's part of it, and what `git diff` takes for the scope; null outside
 * a repository. */
async function scoped(directory: string, scope: Scope, base?: string) {
  const root = (await text(directory, ["rev-parse", "--show-toplevel"]))?.trim();
  if (!root) return null;
  let against = (await git(root, ["rev-parse", "--verify", "-q", "HEAD"])).ok ? "HEAD" : EMPTY_TREE;
  // Since the branch left its base: from where they part, to the files as they are now.
  if (scope === "branch" && base) {
    const fork = (await text(root, ["merge-base", "HEAD", base]))?.trim();
    if (fork) against = fork;
  }
  const relative = path.relative(realOr(root), realOr(directory));
  const limit = relative && !relative.startsWith("..") ? relative.split(path.sep).join("/") : ".";
  const compared = scope === "staged" ? ["--cached", against] : scope === "unstaged" ? [] : [against];
  return { root, against, limit, compared };
}

/** The new files git doesn't know in `limit` (not for `staged`): a repository inside this one
 * ends in "/". */
async function untrackedIn(root: string, limit: string, scope: Scope) {
  if (scope === "staged") return [];
  return ((await text(root, ["-c", "core.quotepath=off", "ls-files", "--others", "--exclude-standard", "-z", "--", limit])) ?? "").split("\0").filter(Boolean);
}

/** Something not committed yet, new files included whatever git's settings say; as if there were
 * when git can't say, so nothing is thrown away on a guess. Always for all but `branch`. */
async function uncommittedIn(root: string, scope: Scope) {
  const status = scope === "branch" ? await text(root, ["status", "--porcelain", "--untracked-files=normal"]) : "x";
  return status === null || status.length > 0;
}

/** What changed in `directory`'s repository in `scope` (`base`: the branch the Branch scope
 * compares with), or `{repository: false}` outside one. */
export async function changesIn(directory: string, scope: Scope, base?: string): Promise<GitChanges | null> {
  const found = await scoped(directory, scope, base);
  if (!found) return { repository: false };
  const { root, against, limit, compared } = found;
  // Its own prefixes, whatever the git settings (diff.noprefix, diff.mnemonicPrefix): a client
  // reads the paths after them. The whole file as context, so a client folds what's unchanged.
  // (The file's own lines, whatever your settings: an unchanged blank line written as " ", none
  // through a converter (textconv). Clients count each line, and review comments name them.) A
  // submodule as git's own diff of its commit, whatever diff.submodule says, so it's listed.
  const args = ["-c", "core.quotepath=off", "-c", "diff.suppressBlankEmpty=false", "-c", "diff.submodule=short", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--find-renames", "--src-prefix=a/", "--dst-prefix=b/", "-U100000"];
  const patch = await text(root, [...args, ...compared, "--", limit]);
  if (patch === null) return null;
  const untracked = await untrackedIn(root, limit, scope);
  const hashes: Record<string, string> = {};
  if (scope !== "staged") {
    // A stamp of each new file (its size and when it last changed), so a client reads one again
    // only when it changed. Cheap for thousands (a project with no .gitignore after an install),
    // which hashing each on every look isn't; read a few at a time, so the box goes on answering
    // meanwhile. None for one that can't be read (a broken link), nor, as git does, for one changed
    // in the last few seconds: a disk that keeps times to the second could change it again, the
    // same size, unseen. A repository inside this one ("web/") is no file.
    const files = untracked.filter(name => !name.endsWith("/"));
    const now = BigInt(Date.now()) * 1_000_000n;
    for (let at = 0; at < files.length; at += 64) {
      await Promise.all(files.slice(at, at + 64).map(async name => {
        try {
          const stat = await fs.promises.stat(path.join(root, name), { bigint: true });
          if (now - stat.mtimeNs > 3_000_000_000n) hashes[name] = `${stat.size}-${stat.mtimeNs}`;
        } catch {}
      }));
    }
  }
  return { repository: true, root, against, patch, untracked, hashes, uncommitted: await uncommittedIn(root, scope) };
}

/** How much changed in `directory`'s repository in `scope`, as `changesIn` would list it but
 * without the diff: each changed file once (a rename by its new path, a file that changed kind as
 * one), new files git doesn't know among them, and git's count of lines added and removed in the
 * files it knows (a binary one has none). New files aren't read: counting is cheap however many. */
export async function countIn(directory: string, scope: Scope, base?: string): Promise<GitChangesCount | null> {
  const found = await scoped(directory, scope, base);
  if (!found) return { repository: false };
  const { root, against, limit, compared } = found;
  const numbers = await git(root, ["-c", "core.quotepath=off", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--find-renames", "--numstat", "-z", ...compared, "--", limit]);
  if (!numbers.ok) return null;
  // `added<TAB>deleted<TAB>path`, or for a rename `added<TAB>deleted<TAB>` then its old and new
  // paths as fields of their own; "-" for a binary file's. A conflicted file comes more than once.
  const seen = new Set<string>();
  let additions = 0;
  let deletions = 0;
  const fields = numbers.out.toString("utf8").split("\0");
  for (let at = 0; at < fields.length; at++) {
    const field = fields[at]!;
    if (!field) continue;
    const [added = "", deleted = "", ...rest] = field.split("\t");
    let name = rest.join("\t");
    if (!name) {
      at += 2;
      name = fields[at] ?? "";
    }
    seen.add(name);
    additions += Number(added) || 0;
    deletions += Number(deleted) || 0;
  }
  // A conflicted file isn't staged: git's staged diff only names it ("Unmerged path"), and a
  // client lists none.
  if (scope === "staged") {
    const unmerged = await git(root, ["-c", "core.quotepath=off", "diff", "--no-ext-diff", "--name-only", "-z", "--diff-filter=U", ...compared, "--", limit]);
    for (const name of unmerged.out.toString("utf8").split("\0")) seen.delete(name);
  }
  // As a client lists them: a new file once, unless the diff has it by that very path.
  const untracked = (await untrackedIn(root, limit, scope)).filter(name => !seen.has(name));
  return { repository: true, root, against, files: seen.size + untracked.length, additions, deletions, untracked: untracked.length, uncommitted: await uncommittedIn(root, scope) };
}

/** To the Trash: on a Mac its own (the box beside the app, or one the app attached to in place), on
 * Linux Kuvo Code's on this box, where it can still be found (`KUVO_CHANGES_TRASH`, a test's own). */
function trash(file: string) {
  const name = path.basename(file);
  let into: string;
  if (process.platform === "darwin" && !process.env.KUVO_CHANGES_TRASH) {
    // The Finder’s own way, so Put Back works (macOS 15 and later have it); `file` is a full path, never an option.
    if (fs.existsSync("/usr/bin/trash")) return void execFileSync("/usr/bin/trash", [file], { stdio: "ignore" });
    const bin = path.join(os.homedir(), ".Trash");
    into = path.join(bin, name);
    for (let n = 2; fs.existsSync(into); n++) into = path.join(bin, `${name} ${n}`);
  } else {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").replace(/\..*/, "");
    into = path.join(process.env.KUVO_CHANGES_TRASH || path.join(K, "trash"), `${stamp}-${process.pid}-${Math.random().toString(36).slice(2, 6)}`, name);
  }
  fs.mkdirSync(path.dirname(into), { recursive: true });
  try {
    fs.renameSync(file, into);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    // On another disk: copied, then removed.
    fs.cpSync(file, into, { recursive: true, verbatimSymlinks: true });
    fs.rmSync(file, { recursive: true, force: true });
  }
}

const kind = (file: string) => {
  try {
    return fs.lstatSync(file);
  } catch {
    return null;
  }
};

/** The first of the folders `name` is in that is something else now, a file or a link: git would
 * delete it to put the folder back. */
function inTheWay(root: string, name: string): string | null {
  const folders = name.split("/").slice(0, -1);
  let at = root;
  for (const folder of folders) {
    at = path.join(at, folder);
    const found = kind(at);
    if (!found) return null;
    if (!found.isDirectory()) return at;
  }
  return null;
}

interface FileAsked {
  path: string;
  oldPath?: string;
  status: Status;
}

/** Stages, unstages or discards one file's changes; null when it went, else what to say. Discard
 * follows the scope: in Unstaged only what isn't staged, otherwise back to the last commit. A
 * file git doesn't know yet goes to the Trash. */
export async function perform(action: "stage" | "unstage" | "discard", root: string, file: FileAsked, scope: Scope): Promise<string | null> {
  const paths = [file.path, ...(file.oldPath ? [file.oldPath] : [])];
  // The file's own path, never a pattern: "app/[slug]/page.tsx" would match others.
  const on = async (args: string[]) => (await git(root, ["--literal-pathspecs", ...args], true)).ok;
  const run = async (args: string[]) => ((await on(args)) ? null : `git couldn’t ${args[0] ?? "do that"} ${file.path}.`);
  const away = (target: string) => {
    try {
      trash(target);
      return null;
    } catch {
      return `Couldn’t move ${path.basename(target)} out of the way.`;
    }
  };
  if (action === "stage") {
    // A rename's old path only while git still has it: once staged as moved, naming it fails.
    const old = file.oldPath && (await on(["ls-files", "--error-unmatch", "--", file.oldPath])) ? [file.oldPath] : [];
    return run(["add", "-A", "--", file.path, ...old]);
  }
  if (action === "unstage") {
    if (await on(["restore", "--staged", "--", ...paths])) return null;
    // A repository with no commits yet has nothing to go back to: out of what's staged, the file
    // left as it is.
    if (!(await on(["rev-parse", "--git-dir"])) || (await on(["rev-parse", "--verify", "-q", "HEAD"]))) return `git couldn’t restore ${file.path}.`;
    return run(["rm", "--cached", "-f", "-q", "--", ...paths]);
  }
  // Out of git first, and only once that worked: a file still staged would go with the next
  // commit. `-f` for one staged and then changed again.
  const untrack = async (name: string) => ((await on(["ls-files", "--error-unmatch", "--", name])) ? run(["rm", "--cached", "-f", "-q", "--", name]) : null);
  // A folder where a file goes back (put in its place, a repository cloned there): git would
  // delete it, and all in it, for good, so it goes to the Trash first; not a submodule that's one
  // already, which git puts back by its commit. A file or link where one of its folders goes back,
  // the same.
  const clear = async (names: string[]) => {
    for (const name of names) {
      const blocking = inTheWay(root, name);
      if (blocking) {
        const failed = away(blocking);
        if (failed) return failed;
        continue;
      }
      const target = path.join(root, name);
      if (!kind(target)?.isDirectory()) continue;
      // Only where git keeps a file (or a link) at that very path: never a folder git keeps (a
      // submodule, which git puts back by its commit, or a folder of files).
      const kept = await text(root, ["--literal-pathspecs", ...(scope === "unstaged" ? ["ls-files", "-s"] : ["ls-tree", "HEAD"]), "--", name]);
      const entry = kept?.split("\n").find(line => line.slice(line.indexOf("\t") + 1) === name);
      if (!entry || !/^(100|120)/.test(entry)) continue;
      const failed = away(target);
      if (failed) return failed;
    }
    return null;
  };
  const gone = (name: string) => (kind(path.join(root, name)) ? away(path.join(root, name)) : null);
  // New to git (untracked, only staged, or only noted with `git add -N`): nothing committed to go
  // back to, so it goes to the Trash.
  if (file.status === "added") return (await untrack(file.path)) ?? gone(file.path);
  // Moved: the new path goes as a new file does, and the old one comes back.
  if (file.status === "renamed" && file.oldPath) {
    const failed = (await untrack(file.path)) ?? (await clear([file.oldPath])) ??
      (await run(scope === "unstaged" ? ["restore", "--worktree", "--", file.oldPath] : ["restore", "--source=HEAD", "--staged", "--worktree", "--", file.oldPath]));
    return failed ?? gone(file.path);
  }
  // A submodule with edits of its own: they're in its repository, and git's restore leaves them
  // as they are and says nothing, which read as done. (One moved to another commit, or gone, goes
  // back as before.)
  if (file.status === "modified" && (await text(root, ["--literal-pathspecs", "ls-files", "-s", "--", file.path]))?.startsWith("160000") &&
      (await text(path.join(root, file.path), ["status", "--porcelain"]))?.trim()) {
    return `${file.path} is a submodule: its changes are in its own repository, so discard them there.`;
  }
  const failed = await clear(scope === "unstaged" ? paths : [file.path]);
  if (failed) return failed;
  return scope === "unstaged" ? run(["restore", "--worktree", "--", ...paths]) : run(["restore", "--source=HEAD", "--staged", "--worktree", "--", file.path]);
}

/** Commits what's staged, or everything in `directory` when nothing is, and pushes if asked; null
 * when it went, else what git said. */
/** What git said when it refused, from `root` (with `author`'s settings), or null when it didn't. */
const refusal = (root: string, author: Record<string, string> = {}) => async (args: string[]) => {
  const ran = await git(root, args, "yours", author);
  if (ran.ok) return null;
  const words = (ran.out.toString("utf8") + "\n" + ran.said).trim();
  return words || `git ${args[0]} failed.`;
};

/** Pushes what `root` has checked out; a new branch pushed and tracked, as `git push -u` would.
 * What git said when it didn't go. */
async function pushFrom(root: string, said = refusal(root)): Promise<string | null> {
  const pushed = await said(["push"]);
  return pushed?.includes("no upstream branch") ? said(["push", "-u", "origin", "HEAD"]) : pushed;
}

/** Commits (and pushes, with `push`): why it didn't, and whether the commit itself landed (only the
 * push not going through), so a client offers Push rather than committing again. */
export async function commit(directory: string, message: string, push: boolean, author: Record<string, string>): Promise<{ failed: string; committed: boolean } | null> {
  const root = (await text(directory, ["rev-parse", "--show-toplevel"]))?.trim();
  if (!root) return { failed: "Not a git repository.", committed: false };
  const said = refusal(root, author);
  if (!(await hasStaged(root))) {
    const relative = path.relative(realOr(root), realOr(directory));
    const failed = await said(["add", "-A", "--", relative && !relative.startsWith("..") ? relative : "."]);
    if (failed) return { failed, committed: false };
  }
  const failed = await said(["commit", "-m", message]);
  if (failed) return { failed, committed: false };
  if (!push) return null;
  const pushed = await pushFrom(root, said);
  return pushed ? { failed: `Committed, but the push didn’t go through:\n${pushed}`, committed: true } : null;
}

/** `directory`'s repository's top folder, or null outside one. */
const rootOf = async (directory: string) => (await text(directory, ["rev-parse", "--show-toplevel"]))?.trim() || null;

/** The repository `directory` is in, as a client's branch menu lists it: its top folder, the branch
 * checked out (null on none) and its branches, the latest commit first; `{repository: false}`
 * outside one, and null when git couldn't say. Read by names only: nothing settings name runs. */
export async function branchesIn(directory: string): Promise<GitBranches | null> {
  const root = await rootOf(directory);
  if (!root) return { repository: false };
  // By their full names: a tag of the same name would have `refname:short` write "heads/x".
  const listed = await text(root, ["for-each-ref", "--sort=-committerdate", "--format=%(refname)", "refs/heads"]);
  if (listed === null) return null;
  const branch = (ref: string) => (ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null);
  const head = (await text(root, ["symbolic-ref", "--quiet", "HEAD"]))?.trim() ?? "";
  return { repository: true, root, current: branch(head), branches: listed.split("\n").map(branch).filter((name): name is string => !!name) };
}

/** Switches `directory`'s repository to `branch`, or (`create`) to a new one from where it is, the
 * changes not committed coming along, as `git switch` does in your terminal (its hooks run). null
 * when it went, else what git said. */
export async function switchBranch(directory: string, branch: string, create: boolean): Promise<string | null> {
  const root = await rootOf(directory);
  if (!root) return "Not a git repository.";
  return refusal(root)(["switch", ...(create ? ["-c"] : []), branch]);
}

/** Whether anything in `directory`'s repository isn't committed: a change, a new file git doesn't
 * ignore, or a change in a submodule whatever its `ignore` setting says, as removing a worktree
 * would delete them; `{repository: false}` outside one, null when git couldn't say. */
export async function statusIn(directory: string): Promise<GitStatus | null> {
  const root = await rootOf(directory);
  if (!root) return { repository: false };
  const status = await text(root, ["status", "--porcelain", "--untracked-files=normal", "--ignore-submodules=none"]);
  return status === null ? null : { repository: true, root, uncommitted: status.length > 0 };
}

/** The branch `directory` has checked out, or null. */
const branchOf =async (directory: string) => (await text(directory, ["symbolic-ref", "--quiet", "--short", "HEAD"]))?.trim() || null;

/** Why `directory`'s branch can't go into `target` yet, if it can't: changes not committed (only
 * what's committed goes), or nothing `target` doesn't have. */
async function unready(directory: string, branch: string, target: string): Promise<string | null> {
  const status = await text(directory, ["status", "--porcelain", "--untracked-files=normal"]);
  if (status === null || status.trim()) return "Commit the changes first. Only what’s committed goes.";
  const ahead = (await text(directory, ["rev-list", "--count", `${target}..HEAD`]))?.trim();
  if (ahead === undefined) return `There’s no branch ${target} to compare with.`;
  return ahead === "0" ? `${branch} has nothing ${target} doesn’t have yet.` : null;
}

/** The box's worktree `directory` is in (its record), if it's one. */
export function worktreeOf(directory: string) {
  const real = realOr(directory);
  return readWorktrees().find(tree => real === realOr(tree.root) || real.startsWith(realOr(tree.root) + path.sep));
}

/** The worktree `directory` is in, for Merge into…: this box's record of it, else, as git has it,
 * a linked worktree's repository's own folder (one made with `git worktree add`, or by the app's
 * own box on this Mac before it attached to this one, which keeps the record). */
async function mergedFrom(directory: string): Promise<{ project: string; base?: string } | null> {
  const tree = worktreeOf(directory);
  if (tree) return tree;
  const [own, common] = ((await text(directory, ["rev-parse", "--absolute-git-dir", "--git-common-dir"])) ?? "").trim().split("\n");
  if (!own || !common) return null;
  const shared = path.resolve(directory, common);
  if (realOr(own) === realOr(shared) || path.basename(shared) !== ".git") return null;
  return { project: path.dirname(shared) };
}

/** Merge into…: what's committed on a worktree's branch merged into `into`, in the project's
 * folder, which must have `into` checked out. Without `into`, the branch the worktree was made from
 * (its record's `base`), else the one the project's folder has checked out. A merge that conflicts
 * is taken back, so the project's folder is as it was, and names the files. `into`: the branch it
 * went into, or would have. */
export async function mergeInto(directory: string, given: string | undefined, author: Record<string, string> = {}): Promise<{ status: number; failed: string; conflicts?: string[]; into?: string } | { into: string }> {
  const tree = await mergedFrom(directory);
  if (!tree || !fs.existsSync(tree.project)) return { status: 409, failed: "Only a worktree’s branch is merged here. Create a pull request instead." };
  const branch = await branchOf(directory);
  if (!branch) return { status: 409, failed: "This folder isn’t on a branch." };
  const target = tree.project;
  const checkedOut = await branchOf(target);
  const into = given ?? tree.base ?? checkedOut;
  if (!into || checkedOut !== into) {
    return { status: 409, failed: checkedOut ? `The project’s folder is on ${checkedOut} now. Switch it back to ${into} to merge, or create a pull request.` : "The project’s folder isn’t on a branch." };
  }
  // One you're in the middle of there is yours: never taken back with this one.
  if ((await git(target, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])).ok) return { status: 409, failed: "The project’s folder is in the middle of a merge. Finish it there first." };
  const why = await unready(directory, branch, into);
  if (why) return { status: 409, failed: why };
  const said = refusal(target, author);
  const failed = await said(["merge", "--no-edit", branch]);
  if (!failed) return { into };
  // By their names as they are: not quoted or escaped, whatever letters are in them.
  const conflicts = ((await text(target, ["-c", "core.quotepath=off", "diff", "--name-only", "-z", "--diff-filter=U"])) ?? "").split("\0").filter(Boolean);
  // Stopped partway for another reason (a hook, signing the commit): taken back too, or the folder
  // stays in the middle of a merge.
  if ((await git(target, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])).ok) await said(["merge", "--abort"]);
  if (!conflicts.length) return { status: 422, failed };
  const named = conflicts.slice(0, 5).join(", ") + (conflicts.length > 5 ? ` and ${conflicts.length - 5} more` : "");
  return { status: 409, failed: `${into} changed some of the same lines: ${named}. Nothing was merged.`, conflicts, into };
}

/** A remote's web page: `git@github.com:me/app.git` and `https://github.com/me/app.git` are both
 * https://github.com/me/app. */
export function webPage(remote: string): URL | null {
  let address = remote.trim().replace(/\.git$/, "");
  if (/^(ssh|git):\/\//.test(address)) address = "https://" + address.replace(/^[a-z]+:\/\//, "").replace(/^[^@/]*@/, "");
  else if (!address.includes("://") && address.includes(":")) {
    // scp-like: git@host:owner/repo
    const colon = address.indexOf(":");
    address = "https://" + address.slice(0, colon).replace(/^[^@]*@/, "") + "/" + address.slice(colon + 1);
  }
  try {
    const page = new URL(address);
    if (page.protocol !== "https:" && page.protocol !== "http:") return null;
    page.protocol = "https:";
    page.username = page.password = page.port = "";
    return page;
  } catch {
    return null;
  }
}

/** The page that opens a pull request for `branch` on GitHub, or a merge request on GitLab, with
 * its title and description when given (null for other hosts). Without a base, the host compares
 * with the repository's main branch. */
export function comparePage(remote: string, branch: string, base: string | undefined, title?: string, body?: string): string | null {
  const page = webPage(remote);
  if (!page) return null;
  const at = page.toString().replace(/\/$/, "");
  const query = new URLSearchParams();
  if (page.hostname.includes("gitlab")) {
    query.set("merge_request[source_branch]", branch);
    if (base) query.set("merge_request[target_branch]", base);
    if (title) query.set("merge_request[title]", title);
    if (body) query.set("merge_request[description]", body);
    return `${at}/-/merge_requests/new?${query}`;
  }
  if (!page.hostname.includes("github")) return null;
  query.set("expand", "1");
  if (title) query.set("title", title);
  if (body) query.set("body", body);
  // A branch's "/" stays, as in GitHub's own links.
  const named = (branch: string) => encodeURIComponent(branch).replace(/%2F/g, "/");
  return `${at}/compare/${(base ? `${named(base)}...` : "") + named(branch)}?${query}`;
}

/** Where `directory`'s repository is pushed: origin's address, or null. */
export const originOf = async (directory: string): Promise<string | null> => (await text(directory, ["remote", "get-url", "origin"]))?.trim() || null;

/** Where a pull request for `directory`'s branch goes, and whether it can go yet: its base is its
 * worktree's, from the box's worktrees, else origin's main branch. */
async function pullRequestWay(directory: string): Promise<{ status: number; failed: string } | { root: string; branch: string; base?: string; against?: string; remote?: string }> {
  const branch = await branchOf(directory);
  if (!branch) return { status: 409, failed: "This folder isn’t on a branch." };
  const root = (await text(directory, ["rev-parse", "--show-toplevel"]))?.trim() ?? directory;
  const recorded = worktreeOf(directory)?.base;
  // Origin's main branch, as git last heard of it; else main or master, here or on origin (a
  // remote added by hand has no HEAD of origin's until it's fetched with one).
  let main = recorded ? undefined : (await text(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]))?.trim().replace(/^origin\//, "") || undefined;
  for (const name of recorded || main ? [] : ["main", "master"]) {
    if ((await git(root, ["rev-parse", "--verify", "-q", name])).ok || (await git(root, ["rev-parse", "--verify", "-q", `origin/${name}`])).ok) {
      main = name;
      break;
    }
  }
  const base = recorded ?? main;
  if (base === branch || (!base && ["main", "master"].includes(branch))) return { status: 409, failed: `${branch} is the branch a pull request goes into. Make one from a branch of its own.` };
  // What the branch has that its base doesn't, compared with the base here, or origin's.
  const against = base && ((await git(root, ["rev-parse", "--verify", "-q", base])).ok ? base : (await git(root, ["rev-parse", "--verify", "-q", `origin/${base}`])).ok ? `origin/${base}` : undefined);
  if (against) {
    const why = await unready(directory, branch, against);
    if (why) return { status: 409, failed: why.replace(`origin/${base}`, base!) };
  }
  const remote = (await text(root, ["remote", "get-url", "origin"]))?.trim() || undefined;
  return { root, branch, base, against, remote };
}

/** Whether GitHub's `gh` can make a pull request on `host` from this box: signed in, not signed
 * in, or not there at all. */
function ghOn(root: string, host: string): Promise<"signed-in" | "signed-out" | "missing"> {
  return new Promise(resolve => {
    execFile("gh", ["auth", "status", "--hostname", host], { cwd: root, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" }, timeout: 30_000 }, error =>
      resolve(!error ? "signed-in" : (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "signed-out"));
  });
}

/** What a pull request for `directory`'s branch would bring, for a model to write it from: its
 * commits, the files they change, and the diff, cut to a size a model reads quickly. */
async function pullRequestSummary(root: string, against: string | undefined, limit = 30_000): Promise<string> {
  const range = against ? `${against}...HEAD` : "HEAD~1...HEAD";
  const commits = (await text(root, ["log", "--no-color", "--format=- %s%n%b", against ? `${against}..HEAD` : "-1"])) ?? "";
  const files = (await text(root, ["diff", "--no-color", "--stat", range])) ?? "";
  let diff = (await text(root, ["diff", "--no-color", "--no-ext-diff", range])) ?? "";
  if (diff.length > limit) diff = diff.slice(0, limit) + "\n…";
  return `Commits:\n${commits}\nFiles:\n${files}\nDiff:\n${diff}`;
}

/** Create Pull Request's confirmation, before anything is pushed: the branch, the base it goes
 * into, a title and description from the commits (as `gh --fill` writes them: one commit's own
 * words, else the branch's name and the commits listed), what it brings for a model to write them
 * from (`withSummary`), and what Create does on this box: makes it with `gh` (`creates`), or, on GitHub with `gh`
 * not signed in or not there (`gh`), on GitLab, opens the host's page; on another host, only
 * pushes. Refused (409) as Create would be. */
export async function pullRequestDraft(directory: string, withSummary = false): Promise<{ status: number; failed: string } | PullRequestDraft> {
  const way = await pullRequestWay(directory);
  if ("failed" in way) return way;
  const { root, branch, base, against, remote } = way;
  const subjects = ((await text(root, ["log", "--no-color", "--format=%s", against ? `${against}..HEAD` : "-1"])) ?? "").split("\n").filter(Boolean);
  let title: string, body: string;
  if (subjects.length === 1) {
    title = subjects[0]!;
    body = ((await text(root, ["log", "-1", "--no-color", "--format=%b"])) ?? "").trim();
  } else {
    const named = branch.replace(/[-_]+/g, " ").trim();
    title = named.charAt(0).toUpperCase() + named.slice(1);
    body = subjects.reverse().map(subject => `- ${subject}`).join("\n");
  }
  const page = remote ? webPage(remote) : null;
  const host = page?.hostname.includes("github") ? "github" : page?.hostname.includes("gitlab") ? "gitlab" : "other";
  const gh = host === "github" ? await ghOn(root, page!.hostname) : undefined;
  return {
    branch, ...(base ? { base } : {}), title, body, ...(withSummary ? { summary: await pullRequestSummary(root, against) } : {}), host,
    creates: gh === "signed-in", ...(gh && gh !== "signed-in" ? { gh } : {}),
  };
}

/** Create Pull Request: `directory`'s branch pushed, and a pull request made with `gh` when it's
 * there and signed in, on origin's GitHub repository (`url`, also one already open for the branch),
 * or the host's page to open one (`compareURL`; neither for a host other than GitHub's or
 * GitLab's). Its base as `pullRequestWay` finds it. */
export async function pullRequest(directory: string, title?: string, body?: string): Promise<{ status: number; failed: string } | { url?: string; compareURL?: string }> {
  const way = await pullRequestWay(directory);
  if ("failed" in way) return way;
  const { root, branch, base, remote } = way;
  const pushed = await refusal(root)(["push", "-u", "origin", "HEAD"]);
  if (pushed) return { status: 422, failed: pushed };
  const page = remote ? webPage(remote) : null;
  if (page?.hostname.includes("github")) {
    // On origin's repository (not a fork's parent), never asking anything, and given up after two
    // minutes without an answer.
    const repository = page.hostname + page.pathname.replace(/\/$/, "");
    const made = await git(root, ["pr", "create", "--repo", repository, "--head", branch, ...(base ? ["--base", base] : []), ...(title ? ["--title", title, "--body", body ?? ""] : ["--fill"])], false,
      { GH_PROMPT_DISABLED: "1", NO_COLOR: "1" }, "gh", 120_000);
    // Made, or one already open for the branch: gh names it either way.
    const url = (made.out.toString("utf8") + "\n" + made.said).match(/https:\/\/\S+\/pull\/\d+/)?.[0];
    if (url) return { url };
  }
  const compareURL = remote ? comparePage(remote, branch, base, title, body) : null;
  return compareURL ? { compareURL } : {};
}

// `diff --quiet` fails when there are differences.
const hasStaged = async (directory: string) => !(await git(directory, ["diff", "--cached", "--quiet"])).ok;

/** The diff a commit would take (what's staged, or everything with new files' names), cut to a
 * size a model reads quickly. */
export async function commitDiff(directory: string, limit = 40_000): Promise<{ diff: string; staged: boolean }> {
  const staged = await hasStaged(directory);
  let diff: string;
  if (staged) diff = (await text(directory, ["diff", "--cached", "--no-color", "--no-ext-diff"])) ?? "";
  else {
    diff = (await text(directory, ["diff", "HEAD", "--no-color", "--no-ext-diff", "--", "."])) ?? "";
    const untracked = ((await text(directory, ["ls-files", "--others", "--exclude-standard"])) ?? "").trim();
    if (untracked) diff += "\nNew files:\n" + untracked;
  }
  return { diff: diff.length > limit ? diff.slice(0, limit) + "\n…" : diff, staged };
}

/** The git author settings a client sent along (`author`), the only ones taken. */
function authorOf(body: Record<string, unknown>): Record<string, string> {
  const given = (body.author ?? {}) as Record<string, unknown>;
  return Object.fromEntries(AUTHOR.flatMap(key => (typeof given[key] === "string" ? [[key, given[key] as string]] : [])));
}

// `kuvo/git/…` (PROTOCOL.md, "Changes").
export async function* changesRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, route, json } = context;
  const method = request.method.toUpperCase();
  if (route === "kuvo/git/show") {
    if (method !== "GET") return yield* json(405, {});
    const asked = new URLSearchParams(request.path.split("?")[1] ?? "");
    const root = folderAt(asked.get("root"));
    const object = asked.get("object") ?? "";
    // "HEAD:path" or ":path" (the index), a commit's or a merge base's: a name git reads, never an option.
    if (!root || !/^[0-9A-Za-z_.\-~^/]*:[^\0]+$/.test(object) || object.startsWith("-")) return yield* json(400, { message: "Name a repository and a file in it." });
    const ran = await git(root, ["cat-file", "-s", object]);
    if (!ran.ok) return yield* json(404, { message: "git has no such file." });
    if (Number(ran.out.toString().trim()) > FILE_LIMIT) return yield* json(413, { message: "That file is too big to open here." });
    const shown = await git(root, ["cat-file", "blob", object]);
    if (!shown.ok) return yield* json(404, { message: "git has no such file." });
    return yield* [{ head: { status: 200, headers: { "content-type": "application/octet-stream", "content-length": String(shown.out.length) } } }, { body: shown.out }];
  }
  if (method !== "POST") return yield* json(405, {});
  const body = (parsed(request.body) ?? {}) as Record<string, unknown>;
  const scope = (body.scope ?? "uncommitted") as Scope;
  if (!SCOPES.includes(scope)) return yield* json(400, { message: "That isn’t a scope." });
  if (route === "kuvo/git/changes") {
    const directory = folderAt(body.directory);
    if (!directory) return yield* json(404, { message: "That folder isn’t there." });
    const found = await changesIn(directory, scope, typeof body.base === "string" && body.base && !body.base.startsWith("-") ? body.base : undefined);
    return yield* found ? json(200, found) : json(500, { message: "git couldn’t read the changes." });
  }
  if (route === "kuvo/git/changes/count") {
    const directory = folderAt(body.directory);
    if (!directory) return yield* json(404, { message: "That folder isn’t there." });
    const found = await countIn(directory, scope, typeof body.base === "string" && body.base && !body.base.startsWith("-") ? body.base : undefined);
    return yield* found ? json(200, found) : json(500, { message: "git couldn’t read the changes." });
  }
  if (route === "kuvo/git/stage" || route === "kuvo/git/unstage" || route === "kuvo/git/discard") {
    const root = folderAt(body.root);
    const name = inRepository(body.path);
    const old = body.oldPath === undefined || body.oldPath === null ? undefined : inRepository(body.oldPath);
    const status = (body.status ?? "modified") as Status;
    if (!root || !name || old === null || !STATUSES.includes(status)) return yield* json(400, { message: "Name a repository and a file in it." });
    const failed = await perform(route.slice("kuvo/git/".length) as "stage" | "unstage" | "discard", root, { path: name, oldPath: old, status }, scope);
    return yield* failed ? json(422, { message: failed }) : json(200, {});
  }
  if (route === "kuvo/git/branches" || route === "kuvo/git/status" || route === "kuvo/git/switch") {
    const directory = folderAt(body.directory);
    if (!directory) return yield* json(404, { message: "That folder isn’t there." });
    if (route === "kuvo/git/switch") {
      // A branch's name, never an option, nor more than one line.
      const branch = typeof body.branch === "string" ? body.branch : "";
      if (!branch.trim() || branch.startsWith("-") || /[\0\n\r]/.test(branch)) return yield* json(400, { message: "Name the branch." });
      const failed = await switchBranch(directory, branch, body.create === true);
      return yield* failed ? json(422, { message: failed }) : json(200, {});
    }
    const found = route === "kuvo/git/branches" ? await branchesIn(directory) : await statusIn(directory);
    return yield* found ? json(200, found) : json(500, { message: "git couldn’t say." });
  }
  if (route === "kuvo/git/commit" || route === "kuvo/git/commit-diff") {
    const directory = folderAt(body.directory);
    if (!directory) return yield* json(404, { message: "That folder isn’t there." });
    if (route === "kuvo/git/commit-diff") {
      const taken = await commitDiff(directory);
      // With what a model is asked to write its message from, your instructions here in it.
      return yield* json(200, body.prompt === true ? { ...taken, prompt: commitPrompt(taken.diff) } : taken);
    }
    const message = typeof body.message === "string" ? body.message : "";
    if (!message.trim()) return yield* json(400, { message: "Write a commit message." });
    const done = await commit(directory, message, body.push === true, authorOf(body));
    return yield* done ? json(422, { message: done.failed, ...(done.committed ? { committed: true, pushed: false } : {}) }) : json(200, {});
  }
  if (route === "kuvo/git/pull-request/draft") {
    const directory = folderAt(body.directory);
    if (!directory) return yield* json(404, { message: "That folder isn’t there." });
    const draft = await pullRequestDraft(directory, body.summary === true || body.prompt === true);
    if ("failed" in draft) return yield* json(draft.status, { message: draft.failed });
    // With what a model is asked to write it from, your instructions here in it.
    return yield* json(200, body.prompt === true ? { ...draft, prompt: pullRequestPrompt(draft.summary ?? "") } : draft);
  }
  // COMPAT(0.7 mac-git-settings): a Mac's Settings › Git from before, kept here once. Goes 3 months after 0.8.0.
  if (route === "kuvo/git/settings/move") {
    const moved = moveGitSettings(body);
    return yield* moved.status === 200 ? json(200, { moved: moved.moved }) : json(moved.status, { message: moved.message });
  }
  if (route === "kuvo/git/push" || route === "kuvo/git/merge" || route === "kuvo/git/pull-request") {
    const directory = folderAt(body.directory);
    if (!directory) return yield* json(404, { message: "That folder isn’t there." });
    if (route === "kuvo/git/push") {
      const root = (await text(directory, ["rev-parse", "--show-toplevel"]))?.trim();
      if (!root) return yield* json(422, { message: "Not a git repository." });
      const failed = await pushFrom(root);
      return yield* failed ? json(422, { message: failed }) : json(200, {});
    }
    if (route === "kuvo/git/merge") {
      // Left out: the branch the worktree was made from.
      const into = body.into ?? undefined;
      if (into !== undefined && (typeof into !== "string" || !into || into.startsWith("-"))) return yield* json(400, { message: "Name the branch to merge into." });
      const merged = await mergeInto(directory, into, authorOf(body));
      return yield* "failed" in merged
        ? json(merged.status, { message: merged.failed, ...(merged.conflicts ? { conflicts: merged.conflicts, into: merged.into } : {}) })
        : json(200, merged);
    }
    const words = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
    const made = await pullRequest(directory, words(body.title), words(body.body));
    // Made from a session (the one in view): its pull request from now on, on its row and card.
    if (!("failed" in made) && made.url && typeof body.session === "string") await linkPull(body.session, made.url).catch(() => false);
    return yield* "failed" in made ? json(made.status, { message: made.failed }) : json(200, made);
  }
  return yield* json(404, {});
}

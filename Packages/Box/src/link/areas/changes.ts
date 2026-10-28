// A project's changes on this box, as the Changes panel shows and works them (PROTOCOL.md,
// "Changes"): what git says changed, staging, unstaging and discarding a file, a file as git keeps
// it (a picture's old side), and committing. A client parses the diff itself; the box runs git, in
// the box's own folders, with the box's git and its settings.

import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parsed } from "../../shared/json";
import type { GitChanges } from "../../shared/routes/changes";
import { K } from "../home";
import type { AnswerPiece, RouteContext } from "../server/context";
import { FILE_LIMIT } from "./file";

// git's empty tree: what a repository with no commits yet is compared with.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
// The most new files hashed, so a client reads only those that changed.
const HASHED = 500;
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
 * git in `folder`, never asking anything. Reading takes no locks it needn't and is stopped after
 * ten minutes (stuck on a lock or a hung disk); what changes the repository (a commit's hooks, a
 * push) takes as long as it takes.
 */
function git(folder: string, args: string[], changing = false, more: Record<string, string> = {}): Promise<Ran> {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", ...(changing ? {} : { GIT_OPTIONAL_LOCKS: "0" }), ...more };
  if (!changing) {
    return new Promise(resolve => {
      execFile("git", args, { cwd: folder, env, encoding: "buffer", maxBuffer: 1024 * 1024 * 1024, timeout: 600_000 }, (error, stdout, stderr) =>
        resolve({ ok: !error, out: stdout ?? Buffer.alloc(0), said: String(stderr ?? "").trim() }));
    });
  }
  // Done when git is: what a hook leaves running (holding its output open) doesn't hold it up.
  return new Promise(resolve => {
    const out: Buffer[] = [];
    const said: Buffer[] = [];
    const child = spawn("git", args, { cwd: folder, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", piece => out.push(piece));
    child.stderr.on("data", piece => said.push(piece));
    child.on("error", () => resolve({ ok: false, out: Buffer.alloc(0), said: "git isn’t there." }));
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

/** What changed in `directory`'s repository in `scope` (`base`: the branch the Branch scope
 * compares with), or `{repository: false}` outside one. */
export async function changesIn(directory: string, scope: Scope, base?: string): Promise<GitChanges | null> {
  const top = (await text(directory, ["rev-parse", "--show-toplevel"]))?.trim();
  if (!top) return { repository: false };
  const root = top;
  let against = (await git(root, ["rev-parse", "--verify", "-q", "HEAD"])).ok ? "HEAD" : EMPTY_TREE;
  // Since the branch left its base: from where they part, to the files as they are now.
  if (scope === "branch" && base) {
    const fork = (await text(root, ["merge-base", "HEAD", base]))?.trim();
    if (fork) against = fork;
  }
  const relative = path.relative(realOr(root), realOr(directory));
  const limit = relative && !relative.startsWith("..") ? relative.split(path.sep).join("/") : ".";
  // Its own prefixes, whatever the git settings (diff.noprefix, diff.mnemonicPrefix): a client
  // reads the paths after them. The whole file as context, so a client folds what's unchanged.
  // (The file's own lines, whatever your settings: an unchanged blank line written as " ", none
  // through a converter (textconv). Clients count each line, and review comments name them.)
  const args = ["-c", "core.quotepath=off", "-c", "diff.suppressBlankEmpty=false", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--find-renames", "--src-prefix=a/", "--dst-prefix=b/", "-U100000"];
  if (scope === "uncommitted" || scope === "branch") args.push(against);
  if (scope === "staged") args.push("--cached", against);
  const patch = await text(root, [...args, "--", limit]);
  if (patch === null) return null;
  let untracked: string[] = [];
  const hashes: Record<string, string> = {};
  if (scope !== "staged") {
    untracked = ((await text(root, ["-c", "core.quotepath=off", "ls-files", "--others", "--exclude-standard", "-z", "--", limit])) ?? "").split("\0").filter(Boolean);
    // git's hash of each new file (as it is, no filters run), so a client reads one again only when
    // it changed. One git can't hash (a broken link) fails the call: then each on its own. A
    // repository inside this one ("web/") is no file.
    const files = untracked.filter(name => !name.endsWith("/")).slice(0, HASHED);
    const all = files.length ? (await text(root, ["hash-object", "--no-filters", "--", ...files]))?.trim().split("\n") : [];
    if (all && all.length === files.length) files.forEach((name, at) => (hashes[name] = all[at]));
    else for (const name of files) {
      const one = (await text(root, ["hash-object", "--no-filters", "--", name]))?.trim();
      if (one) hashes[name] = one;
    }
  }
  // Something not committed yet, new files included whatever git's settings say; as if there were
  // when git can't say, so nothing is thrown away on a guess.
  const status = scope === "branch" ? await text(root, ["status", "--porcelain", "--untracked-files=normal"]) : "x";
  return { repository: true, root, against, patch, untracked, hashes, uncommitted: status === null || status.length > 0 };
}

/** To the Trash: on a Mac its own, elsewhere (no Trash) Kuvo Code's on this box, where it can
 * still be found (`KUVO_CHANGES_TRASH`, a test's own). */
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
  const failed = await clear(scope === "unstaged" ? paths : [file.path]);
  if (failed) return failed;
  return scope === "unstaged" ? run(["restore", "--worktree", "--", ...paths]) : run(["restore", "--source=HEAD", "--staged", "--worktree", "--", file.path]);
}

/** Commits what's staged, or everything in `directory` when nothing is, and pushes if asked; null
 * when it went, else what git said. */
export async function commit(directory: string, message: string, push: boolean, author: Record<string, string>): Promise<string | null> {
  const root = (await text(directory, ["rev-parse", "--show-toplevel"]))?.trim();
  if (!root) return "Not a git repository.";
  const said = async (args: string[]) => {
    const ran = await git(root, args, true, author);
    if (ran.ok) return null;
    const words = (ran.out.toString("utf8") + "\n" + ran.said).trim();
    return words || `git ${args[0]} failed.`;
  };
  if (!(await hasStaged(root))) {
    const relative = path.relative(realOr(root), realOr(directory));
    const failed = await said(["add", "-A", "--", relative && !relative.startsWith("..") ? relative : "."]);
    if (failed) return failed;
  }
  const failed = await said(["commit", "-m", message]);
  if (failed || !push) return failed;
  let pushed = await said(["push"]);
  // A new branch: pushed and tracked, as `git push -u` would.
  if (pushed?.includes("no upstream branch")) pushed = await said(["push", "-u", "origin", "HEAD"]);
  return pushed && `Committed, but the push didn’t go through:\n${pushed}`;
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
  if (route === "kuvo/git/stage" || route === "kuvo/git/unstage" || route === "kuvo/git/discard") {
    const root = folderAt(body.root);
    const name = inRepository(body.path);
    const old = body.oldPath === undefined || body.oldPath === null ? undefined : inRepository(body.oldPath);
    const status = (body.status ?? "modified") as Status;
    if (!root || !name || old === null || !STATUSES.includes(status)) return yield* json(400, { message: "Name a repository and a file in it." });
    const failed = await perform(route.slice("kuvo/git/".length) as "stage" | "unstage" | "discard", root, { path: name, oldPath: old, status }, scope);
    return yield* failed ? json(422, { message: failed }) : json(200, {});
  }
  if (route === "kuvo/git/commit" || route === "kuvo/git/commit-diff") {
    const directory = folderAt(body.directory);
    if (!directory) return yield* json(404, { message: "That folder isn’t there." });
    if (route === "kuvo/git/commit-diff") return yield* json(200, await commitDiff(directory));
    const message = typeof body.message === "string" ? body.message : "";
    if (!message.trim()) return yield* json(400, { message: "Write a commit message." });
    const given = (body.author ?? {}) as Record<string, unknown>;
    const author = Object.fromEntries(AUTHOR.flatMap(key => (typeof given[key] === "string" ? [[key, given[key] as string]] : [])));
    const failed = await commit(directory, message, body.push === true, author);
    return yield* failed ? json(422, { message: failed }) : json(200, {});
  }
  return yield* json(404, {});
}

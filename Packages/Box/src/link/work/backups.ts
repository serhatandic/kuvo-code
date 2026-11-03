// Your repositories' branches and stashes, kept as each agent's turn starts and ends, so what a
// hard reset, a deleted branch, a dropped stash or `rm -rf .git` took can be taken back. It covers
// every agent, the engine's and the coding agents', in any approval: the box watches their runs
// (`engine/watch.ts`).
//
// Each repository gets a store of the box's own, `box/branch-backups/<id>` (a bare git repository
// that only Kuvo Code writes, never the project's), keyed by the repository's top folder, so it's
// found again after its `.git` is gone. A backup is a list of what the branches pointed at, which
// branch was checked out, the stashes and the remotes (their addresses without sign-ins); the store
// keeps each commit it names (`refs/kuvo/keep/<commit>`, once however many backups name it). A
// backup is taken only when something changed since the last one; the newest 100 are kept, and
// none older than 30 days but the newest. The first backup of a repository links its objects where
// the system can (a local clone), so it takes next to no room.
//
// Taking one back never moves a branch you have: one that's gone comes back under its name, one
// that's elsewhere now comes back beside it (`<branch>-restored-<when>`), stashes you no longer
// have come back on the stash list, and a repository whose `.git` is gone is made again around your
// files as they are (none of them changed), with its branches, stashes and remotes.

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { engineGet } from "../engine/client";
import { BOX } from "../home";
import { textOf, writePrivate } from "../../shared/files";
import type { EngineAnswer } from "../engine/client";
import type { EngineSession } from "../engine/sessions";
import type { Target } from "../../shared/records";

export const BACKUPS_FOLDER = path.join(BOX, "branch-backups");
/** How many backups a repository keeps, and for how long (the newest is always kept). */
const KEEP = 100;
const KEEP_FOR = 30 * 24 * 60 * 60 * 1000;

export interface Backup {
  id: string;
  at: number;
  /** The branch checked out, or the commit for a detached one. */
  head: { branch: string } | { commit: string } | null;
  branches: Record<string, string>;
  /** Newest first, as `git stash list` shows them. */
  stashes: { commit: string; message: string }[];
  remotes: Record<string, string>;
}

interface Index {
  /** The repository's top folder. */
  repository: string;
  backups: Backup[];
}

// git with nothing of the repository's own run: no hooks, filters, pager, fsmonitor or
// credentials, never asking anything.
const SAFE = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.pager=cat", "-c", "credential.helper=", "-c", "diff.external=", "-c", "protocol.file.allow=always", "-c", "gc.autoDetach=false"];
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_ASKPASS: "", SSH_ASKPASS: "" };

interface Ran { ok: boolean; out: string; error: string }
function git(args: string[], options: { cwd?: string; input?: string } = {}): Promise<Ran> {
  return new Promise(resolve => {
    const child = execFile("git", [...SAFE, ...args], { cwd: options.cwd, env: ENV, encoding: "utf8", timeout: 300_000, maxBuffer: 64 * 1024 * 1024 }, (error, out, err) =>
      resolve({ ok: !error, out: String(out ?? ""), error: String(err ?? "").trim() || (error ? String(error.message) : "") }));
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

/** The repository `folder` is in: its top folder (the main one, for a linked worktree's) and its
 * git folder; null where it isn't in one. */
export async function repositoryOf(folder: string): Promise<{ top: string; gitDir: string } | null> {
  const ran = await git(["-C", folder, "rev-parse", "--git-common-dir", "--show-toplevel"]);
  if (!ran.ok) return null;
  const [common, shown] = ran.out.split("\n").map(line => line.trim());
  if (!common) return null;
  let gitDir: string;
  try { gitDir = fs.realpathSync(path.resolve(folder, common)); } catch { return null; }
  // The main worktree's top folder where its git folder is `.git` in it; otherwise (a separate git
  // folder) the one this worktree has.
  try {
    const top = path.basename(gitDir) === ".git" ? path.dirname(gitDir) : shown ? fs.realpathSync(shown) : null;
    return top ? { top, gitDir } : null;
  } catch {
    return null;
  }
}

const storeId = (top: string) => crypto.createHash("sha1").update(top).digest("hex").slice(0, 20);
const storeOf = (top: string, root: string) => path.join(root, storeId(top));
const indexFile = (top: string, root: string) => path.join(storeOf(top, root), "backups.json");
const gitStore = (top: string, root: string) => path.join(storeOf(top, root), "store");

function readIndex(top: string, root: string): Index {
  try {
    const index = JSON.parse(textOf(indexFile(top, root)) ?? "") as Index;
    if (index.repository === top && Array.isArray(index.backups)) return index;
  } catch {}
  return { repository: top, backups: [] };
}

// One git operation at a time on a store, and on the repository it's taken back into.
const queues = new Map<string, Promise<unknown>>();
function one<T>(key: string, work: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).then(work, work);
  const settled = next.catch(() => {});
  queues.set(key, settled);
  settled.then(() => { if (queues.get(key) === settled) queues.delete(key); });
  return next;
}

/** What a repository has now: its branches, what's checked out, its stashes and its remotes. */
async function stateOf(gitDir: string): Promise<Omit<Backup, "id" | "at"> | null> {
  const at = ["--git-dir", gitDir];
  const refs = await git([...at, "for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads"]);
  if (!refs.ok) return null;
  const branches: Record<string, string> = {};
  for (const line of refs.out.split("\n")) {
    const [ref, commit] = line.split("\0");
    if (ref?.startsWith("refs/heads/") && commit) branches[ref.slice("refs/heads/".length)] = commit;
  }
  const symbolic = await git([...at, "symbolic-ref", "-q", "HEAD"]);
  let head: Backup["head"] = null;
  if (symbolic.ok && symbolic.out.trim().startsWith("refs/heads/")) head = { branch: symbolic.out.trim().slice("refs/heads/".length) };
  else {
    const detached = await git([...at, "rev-parse", "-q", "--verify", "HEAD^{commit}"]);
    if (detached.ok && detached.out.trim()) head = { commit: detached.out.trim() };
  }
  const stashes: Backup["stashes"] = [];
  const stash = await git([...at, "log", "-g", "--format=%H%x00%gs", "refs/stash", "--"]);
  if (stash.ok) for (const line of stash.out.split("\n")) {
    const [commit, message] = line.split("\0");
    if (commit && /^[0-9a-f]{40,64}$/.test(commit)) stashes.push({ commit, message: message ?? "" });
  }
  const remotes: Record<string, string> = {};
  const urls = await git([...at, "config", "--get-regexp", "^remote\\..*\\.url$"]);
  if (urls.ok) for (const line of urls.out.split("\n")) {
    const found = line.match(/^remote\.(.+)\.url (.+)$/);
    if (found) remotes[found[1]!] = withoutSignIn(found[2]!);
  }
  return { head, branches, stashes, remotes };
}

/** An address without the sign-in some put in it (`https://user:token@host/…`). */
function withoutSignIn(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1");
}

const same = (a: Omit<Backup, "id" | "at">, b: Omit<Backup, "id" | "at">) =>
  JSON.stringify([a.head, Object.entries(a.branches).sort(), a.stashes.map(each => each.commit), Object.entries(a.remotes).sort()])
  === JSON.stringify([b.head, Object.entries(b.branches).sort(), b.stashes.map(each => each.commit), Object.entries(b.remotes).sort()]);

const commitsOf = (backup: Pick<Backup, "head" | "branches" | "stashes">) =>
  [...Object.values(backup.branches), ...backup.stashes.map(each => each.commit), ...(backup.head && "commit" in backup.head ? [backup.head.commit] : [])];

/** Makes a repository's store: from a local clone of it, which links its objects where it can. */
async function makeStore(store: string, gitDir: string): Promise<boolean> {
  fs.mkdirSync(path.dirname(store), { recursive: true, mode: 0o700 });
  const cloned = await git(["clone", "--bare", "--local", "--no-tags", "--template=", "-q", gitDir, store]);
  if (!cloned.ok) {
    fs.rmSync(store, { recursive: true, force: true });
    const made = await git(["init", "--bare", "--template=", "-q", store]);
    if (!made.ok) return false;
  }
  // Nothing of the clone's own refs or remote: only what the backups keep. Its packs stay linked
  // (packed again only as loose objects pile up, never all at once).
  const own = await git(["--git-dir", store, "for-each-ref", "--format=%(refname)"]);
  const deletes = own.out.split("\n").filter(ref => ref && !ref.startsWith("refs/kuvo/")).map(ref => `delete ${ref}\n`).join("");
  if (deletes) await git(["--git-dir", store, "update-ref", "--stdin"], { input: deletes });
  await git(["--git-dir", store, "config", "--remove-section", "remote.origin"]);
  await git(["--git-dir", store, "config", "gc.autoPackLimit", "0"]);
  return true;
}

/** Keeps each commit `wanted` names in the store: fetched from the repository where the store
 * doesn't have it yet. Whether all of them are kept. */
async function keepCommits(store: string, gitDir: string, wanted: string[]): Promise<boolean> {
  const unique = [...new Set(wanted)];
  if (!unique.length) return true;
  const checked = await git(["--git-dir", store, "cat-file", "--batch-check=%(objectname)"], { input: unique.map(each => `${each}^{commit}\n`).join("") });
  const have = new Set(checked.out.split("\n").filter(line => /^[0-9a-f]+$/.test(line)));
  const missing = unique.filter(each => !have.has(each));
  // (Stashes past the newest aren't refs the repository shows, so they're asked for by commit.)
  for (let start = 0; start < missing.length; start += 200) {
    const specs = missing.slice(start, start + 200).map(each => `+${each}:refs/kuvo/keep/${each}`);
    const fetched = await git(["--git-dir", store, "-c", "uploadpack.allowAnySHA1InWant=true", "fetch", "--no-tags", "-q", gitDir, ...specs]);
    if (!fetched.ok) return false;
  }
  const creates = unique.filter(each => have.has(each)).map(each => `update refs/kuvo/keep/${each} ${each}\n`).join("");
  return !creates || (await git(["--git-dir", store, "update-ref", "--stdin"], { input: creates })).ok;
}

/** Takes a backup of the repository `folder` is in, where something changed since its last one:
 * the backup taken, or null (nothing changed, not in a repository, or it failed). */
export function takeBackup(folder: string, root = BACKUPS_FOLDER, now = Date.now()): Promise<Backup | null> {
  return repositoryOf(folder).then(repository => {
    if (!repository) return null;
    return one(storeOf(repository.top, root), async () => {
      const state = await stateOf(repository.gitDir);
      if (!state || (!Object.keys(state.branches).length && !state.stashes.length)) return null;
      const index = readIndex(repository.top, root);
      const last = index.backups.at(-1);
      if (last && same(last, state)) return null;
      const store = gitStore(repository.top, root);
      if (!fs.existsSync(path.join(store, "HEAD")) && !await makeStore(store, repository.gitDir)) return null;
      if (!await keepCommits(store, repository.gitDir, commitsOf(state))) return null;
      const backup: Backup = { id: `${now.toString(36)}${crypto.randomBytes(2).toString("hex")}`, at: now, ...state };
      const kept = [...index.backups, backup].filter((each, at, all) => at === all.length - 1 || (all.length - at <= KEEP && now - each.at <= KEEP_FOR));
      writePrivate(indexFile(repository.top, root), JSON.stringify({ repository: repository.top, backups: kept } satisfies Index));
      await letGo(store, index.backups.filter(each => !kept.includes(each)), kept);
      return backup;
    });
  }).catch(() => null);
}

/** A backup of the repository a conversation works in (on the engine or the coding agents'
 * bridge, `source`), as its run starts or ends. */
export async function backUpSession(source: Target, session: string): Promise<void> {
  const data = (await engineGet(source, `api/session/${encodeURIComponent(session)}`).catch(() => null) as EngineAnswer<EngineSession> | null)?.data;
  const folder = data?.location?.directory ?? data?.directory;
  if (typeof folder === "string" && path.isAbsolute(folder)) await takeBackup(folder);
}

/** The commits only backups no longer kept named, let go (and the store packed now and then). */
async function letGo(store: string, dropped: Backup[], kept: Backup[]): Promise<void> {
  if (!dropped.length) return;
  const still = new Set(kept.flatMap(commitsOf));
  const gone = [...new Set(dropped.flatMap(commitsOf))].filter(each => !still.has(each));
  if (gone.length) await git(["--git-dir", store, "update-ref", "--stdin"], { input: gone.map(each => `delete refs/kuvo/keep/${each}\n`).join("") });
  await git(["--git-dir", store, "gc", "--auto", "-q"]);
}

/** Where `folder`'s backups are: its repository's, or where it isn't in one now (its `.git` gone),
 * the repository it, or a folder above it, was. */
async function backedUpAt(folder: string, root: string): Promise<{ top: string; gitDir: string | null } | null> {
  const repository = await repositoryOf(folder);
  if (repository) return repository;
  let at: string;
  try { at = fs.realpathSync(folder); } catch { return null; }
  for (;;) {
    if (readIndex(at, root).backups.length) return { top: at, gitDir: null };
    const up = path.dirname(at);
    if (up === at) return null;
    at = up;
  }
}

export interface BackupShown {
  id: string;
  at: number;
  /** The branch checked out then (or "" for a detached one). */
  head: string;
  branches: number;
  stashes: number;
  /** What taking it back would bring back now: branches gone, branches elsewhere now, and stashes
   * no longer on the list. */
  gone: string[];
  moved: string[];
  stashesGone: number;
}

/** The backups of the repository `folder` is in (or was), newest first, each with what taking it
 * back would bring back now. */
export async function listBackups(folder: string, root = BACKUPS_FOLDER): Promise<{ repository: string | null; exists: boolean; backups: BackupShown[] }> {
  const at = await backedUpAt(folder, root);
  if (!at) return { repository: null, exists: false, backups: [] };
  const now = at.gitDir ? await stateOf(at.gitDir) : null;
  const stashesNow = new Set(now?.stashes.map(each => each.commit) ?? []);
  const backups = readIndex(at.top, root).backups.slice().reverse().map(backup => ({
    id: backup.id, at: backup.at,
    head: backup.head && "branch" in backup.head ? backup.head.branch : "",
    branches: Object.keys(backup.branches).length, stashes: backup.stashes.length,
    gone: Object.keys(backup.branches).filter(name => !now?.branches[name]),
    moved: Object.keys(backup.branches).filter(name => now?.branches[name] && now.branches[name] !== backup.branches[name]),
    stashesGone: backup.stashes.filter(each => !stashesNow.has(each.commit)).length,
  }));
  return { repository: at.top, exists: Boolean(at.gitDir), backups };
}

export interface Restored {
  /** The repository made again, where its `.git` was gone. */
  remade: boolean;
  /** Each branch brought back, and the name it has now. */
  branches: { name: string; as: string }[];
  stashes: number;
}

export class RestoreError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

const stamp = (at: number) => new Date(at).toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");

/** Takes backup `id` of the repository `folder` is in (or was) back. */
export async function restoreBackup(folder: string, id: string, root = BACKUPS_FOLDER): Promise<Restored> {
  const at = await backedUpAt(folder, root);
  if (!at) throw new RestoreError("There are no backups of a repository here.", 404);
  return one(storeOf(at.top, root), async () => {
    const backup = readIndex(at.top, root).backups.find(each => each.id === id);
    if (!backup) throw new RestoreError("That backup isn't here.", 404);
    const store = gitStore(at.top, root);
    let gitDir = at.gitDir;
    let remade = false;
    if (!gitDir) {
      // Made again where it was, around the files as they are.
      if (fs.existsSync(path.join(at.top, ".git"))) throw new RestoreError("This folder's .git can't be read.", 409);
      const made = await git(["init", "-q", "--template=", at.top]);
      if (!made.ok) throw new RestoreError(`The repository couldn't be made again: ${made.error}`, 500);
      gitDir = path.join(at.top, ".git");
      remade = true;
    }
    const now = (await stateOf(gitDir)) ?? { head: null, branches: {}, stashes: [], remotes: {} };
    const when = stamp(backup.at);
    const names = new Set(Object.keys(now.branches));
    const free = (name: string) => {
      let candidate = name;
      for (let n = 2; names.has(candidate); n++) candidate = `${name}-${n}`;
      names.add(candidate);
      return candidate;
    };
    const branches: Restored["branches"] = [];
    for (const [name, commit] of Object.entries(backup.branches)) {
      if (now.branches[name] === commit) continue;
      branches.push({ name, as: now.branches[name] ? free(`${name}-restored-${when}`) : free(name) });
    }
    // A detached one's commit, where no branch brought back or kept has it.
    const detached = backup.head && "commit" in backup.head ? backup.head.commit : null;
    if (detached && !Object.values(backup.branches).includes(detached) && !Object.values(now.branches).includes(detached)) branches.push({ name: "", as: free(`detached-restored-${when}`) });
    const stashes = backup.stashes.filter(each => !now.stashes.some(have => have.commit === each.commit));
    // Each from the store's own ref for its commit.
    const specs = [
      ...branches.map(each => `+refs/kuvo/keep/${each.name ? backup.branches[each.name] : detached}:refs/heads/${each.as}`),
      ...stashes.map(each => `+refs/kuvo/keep/${each.commit}:refs/kuvo-restoring/${each.commit}`),
    ];
    if (specs.length) {
      const fetched = await git(["--git-dir", gitDir, "fetch", "--no-tags", "-q", "--update-head-ok", store, ...specs]);
      if (!fetched.ok) throw new RestoreError(`The backup couldn't be taken back: ${fetched.error}`, 500);
    }
    // Stashes back on the list, oldest first so the newest is on top, as they were.
    const tree = ["--git-dir", gitDir, "--work-tree", at.top];
    for (const each of stashes.slice().reverse()) await git([...tree, "stash", "store", "-m", each.message || "restored", each.commit], { cwd: at.top });
    if (stashes.length) await git(["--git-dir", gitDir, "update-ref", "--stdin"], { input: stashes.map(each => `delete refs/kuvo-restoring/${each.commit}\n`).join("") });
    if (remade) {
      for (const [name, url] of Object.entries(backup.remotes)) await git(["--git-dir", gitDir, "remote", "add", name, url]);
      const checkedOut = backup.head && "branch" in backup.head ? backup.head.branch : null;
      const head = branches.find(each => each.name && each.name === checkedOut)?.as;
      if (head) {
        await git(["--git-dir", gitDir, "symbolic-ref", "HEAD", `refs/heads/${head}`]);
        // The index from that branch, the files as they are.
        await git([...tree, "reset", "-q"], { cwd: at.top });
      }
    }
    return { remade, branches, stashes: stashes.length };
  });
}

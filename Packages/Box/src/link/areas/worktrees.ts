// Worktrees (PROTOCOL.md, "Worktrees"): the git worktrees sessions here run in, each on a
// branch of its own, kept by this box (`box/worktrees.json`): made, named after their session,
// listed and removed here, from a Mac (through `box route`) or a phone, with the Mac closed too.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { askedArgs } from "../../shared/git";
import { parsed } from "../../shared/json";
import type { Fields } from "../../shared/json";
import type { EngineRecord, Target } from "../../shared/records";
import type { ListedRestorable, ListedWorktree, WorktreeRecordShape, Worktrees, WorktreesWhere } from "../../shared/routes/worktrees";
import { bridgeTarget, call, engineGet, readBridgeFile, readEngineFile } from "../engine/client";
import type { EngineAnswer } from "../engine/client";
import { isHiddenRun } from "../engine/sessions";
import type { EngineSession } from "../engine/sessions";
import { followed } from "../follow";
import { BY_KUVO, firstCommit, gitAsked, gitIn, gitLater, sizeLater } from "../git";
import { ENGINE_DATA, homeFolder } from "../home";
import type { AnswerPiece, JSONAnswer, RouteContext } from "../server/context";
import { readProjects } from "./projects";
import { branchPrefixHere } from "./git-words";
import { readRemovedWorktrees, readRestorableWorktrees, readWorktrees, updateWorktrees, worktreeFollowers } from "./worktree-records";
import type { RestorableWorktree, WorktreeRecord } from "./worktree-records";

/** Sessions by the folder they run in, and which are at work (their ids). */
interface SessionsHere {
  sessions: EngineSession[];
  active: Set<string>;
}

/** What a client sends `kuvo/worktrees…`, as it comes: a new one's project (and an older Mac's
 * branch prefix), one an older Mac kept, one to remove (`path`, `forget`, `discard`), or one to restore (`folder`, where
 * its sessions ran). Each is checked as it's used. */
export interface WorktreesBody {
  project?: unknown;
  branchPrefix?: unknown;
  root?: unknown;
  folder?: unknown;
  branch?: unknown;
  base?: unknown;
  path?: unknown;
  forget?: unknown;
  discard?: unknown;
  /** One an older Mac removed before its box kept their records (`kuvo/worktrees/record`). */
  removed?: unknown;
}

/** What `kuvo/worktrees…` answers: the list, one just made, `{}` for done (or nothing to say), or
 * why not. */
export type WorktreesAnswer = JSONAnswer<Worktrees | WorktreeRecordShape | { message: string } | Record<string, never>>;

/** A project as `kuvo/worktrees/where` tells of it. */
type WhereProject = WorktreesWhere["projects"][number];

/** `name`, or `name-2` and so on when that's a branch already, here or on a remote (an old pull
 * request's, deleted here), as the Mac's Git.newBranch picks. */
function freeBranch(folder: string, name: string): string | null {
  for (let suffix = 1; suffix <= 20; suffix++) {
    const candidate = suffix === 1 ? name : `${name}-${suffix}`;
    if (gitIn(folder, ["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`]) === null && !onRemote(folder, candidate)) return candidate;
  }
  return null;
}

/** Whether a remote has `branch` (pushed from here, tracked or not, as git last heard). */
const onRemote = (folder: string, branch: string): boolean => Boolean(gitIn(folder, ["for-each-ref", "--count=1", "--format=%(refname)", `refs/remotes/*/${branch}`]));

// Cyrillic and Greek letters in Latin ones, as ICU writes them without their marks: "Исправить
// вход" is ispravit-vhod, "Διόρθωση σύνδεσης" diorthose-syndeses.
const LATIN: Record<string, string> = Object.fromEntries([
  ...[..."абвгдеёжзийклмнопрстуфхцчшщъыьэюяіїєґ"].map((letter, at) =>
    [letter, ["a", "b", "v", "g", "d", "e", "e", "z", "z", "i", "j", "k", "l", "m", "n", "o", "p", "r", "s", "t", "u", "f", "h", "c", "c", "s", "s", "", "y", "", "e", "u", "a", "i", "i", "e", "g"][at]]),
  ...[..."αβγδεζηθικλμνξοπρσςτυφχψω"].map((letter, at) =>
    [letter, ["a", "b", "g", "d", "e", "z", "e", "th", "i", "k", "l", "m", "n", "x", "o", "p", "r", "s", "s", "t", "y", "ph", "ch", "ps", "o"][at]]),
]);
const inLatin = (text: string): string => [...text].map(letter => LATIN[letter] ?? letter).join("");

/** A branch name made from a title, in Latin letters without their marks: "Trim note titles" is
 * trim-note-titles, "Giriş düzeltmesi" giris-duzeltmesi, "Исправить вход" ispravit-vhod. A title
 * in other letters (Chinese, Arabic) names none: its branch keeps the name it was made with. */
export function branchSlug(title: unknown, limit = 40): string {
  // Whole letters first (й is j, not i), then those that came apart from their marks (ό).
  const latin = inLatin(inLatin(String(title).toLowerCase()).normalize("NFKD")).replace(/\p{M}/gu, "").replace(/ı/g, "i");
  let name = "";
  for (const word of latin.split(/[^\p{L}\p{N}]+/u)) {
    const ascii = [...word].filter(character => character.charCodeAt(0) < 128).join("");
    if (!ascii) continue;
    const next = name ? `${name}-${ascii}` : ascii;
    if (next.length > limit) break;
    name = next;
  }
  return name;
}

/** Its engine's project for a folder, as it names projects. */
async function projectOf(engine: Target, folder: string, signal: AbortSignal | undefined): Promise<string> {
  const located = await call(engine, "GET", "/api/location", undefined, signal, folder) as { project?: Fields<"id"> } | null;
  const id = located?.project?.id;
  if (typeof id !== "string") throw new Error("The engine didn't say which project that is.");
  return id;
}

/** Sessions by the folder they run in, and which are at work, as its engine and the coding agents'
 * bridge (while it runs) have them, every one (page after page: one further back still counts);
 * null when one of them can't say. */
async function sessionsHere(engine: Target | null, signal: AbortSignal | undefined, bridge: Target | null = bridgeTarget()): Promise<SessionsHere | null> {
  if (!engine?.port) return null;
  const here: SessionsHere = { sessions: [], active: new Set() };
  for (const target of bridge?.port && bridge.port !== engine.port ? [engine, bridge] : [engine]) {
    const headers = { authorization: `Basic ${Buffer.from(`opencode:${target.password}`).toString("base64")}` };
    try {
      let query: string | null = "parentID=null&limit=200&order=desc";
      for (let pages = 0; query; pages++) {
        // (A list that doesn't end can't say.)
        if (pages === 100 || signal?.aborted) return null;
        const listed = await fetch(`http://127.0.0.1:${target.port}/api/session?${query}`, { headers, signal: AbortSignal.timeout(10_000) });
        if (!listed.ok) return null;
        // (As they answer it: their sessions, each whole, and where the next page starts.)
        const page = await listed.json() as { data?: EngineSession[]; cursor?: { next?: string } | null } | null;
        const data = page?.data ?? [];
        here.sessions.push(...data);
        const next = page?.cursor?.next;
        query = data.length === 200 && next ? `parentID=null&limit=200&cursor=${encodeURIComponent(next)}` : null;
      }
      const busy = await fetch(`http://127.0.0.1:${target.port}/api/session/active`, { headers, signal: AbortSignal.timeout(10_000) });
      if (!busy.ok) return null;
      // (Those at work, by id or as a list.)
      const active = ((await busy.json()) as { data?: string[] | Record<string, unknown> } | null)?.data ?? {};
      for (const id of Array.isArray(active) ? active : Object.keys(active)) here.active.add(id);
    } catch {
      return null;
    }
  }
  return here;
}

const inside = (folder: string | undefined, root: string) => folder === root || folder?.startsWith(root + "/");

/** `tree`'s branch named `to` (or `to-2` and so on), unless it's been pushed: whether it was. */
function renameWorktree(tree: WorktreeRecord, to: string): boolean {
  if (gitIn(tree.root, ["rev-parse", "--abbrev-ref", `${tree.branch}@{upstream}`]) !== null) return false;
  // Pushed without tracking it (`git push origin HEAD`): a remote has it all the same.
  if (onRemote(tree.root, tree.branch)) return false;
  const name = freeBranch(tree.root, to);
  if (!name || gitIn(tree.root, ["branch", "-m", tree.branch, name]) === null) {
    // Renamed meanwhile (by this box's other process, named as it was read): kept as git has it.
    const now = gitIn(tree.root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (now && now !== tree.branch) updateWorktrees(list => list.map(each => (each.root === tree.root ? { ...each, branch: now } : each)));
    return false;
  }
  updateWorktrees(list => list.map(each => (each.root === tree.root ? { ...each, branch: name } : each)));
  return true;
}

/** A worktree made here, named after its session once that has a title (this box names its own,
 * Mac connected or not; a Mac names only its own): one still on the branch it was made on, and
 * not pushed. Its session is told the new name, as it was told the one before: whether it was. */
export async function nameWorktreeBranch(engine: Target, sessionID: unknown): Promise<boolean> {
  if (typeof sessionID !== "string") return false;
  const session: EngineSession | undefined = (await engineGet(engine, `api/session/${encodeURIComponent(sessionID)}`) as EngineAnswer<EngineSession>)?.data;
  // Not after a subagent's title, nor an engine run's a coding agent's session started.
  if (!session || session.parentID || isHiddenRun(session)) return false;
  const folder = session.location?.directory ?? session.directory;
  // Read now, after the wait: what another naming did meanwhile shows.
  const tree = readWorktrees().find(each => (each.folder ?? each.root) === folder);
  const slug = branchSlug(session.title ?? "");
  if (!tree?.made || tree.branch !== tree.made || !slug) return false;
  if (!renameWorktree(tree, (tree.prefix ?? "") + slug)) return false;
  await tellRenamed(engine, tree, sessionID);
  return true;
}

/** Each session working in `tree` (on its engine, and with the coding agents), told its branch's
 * new name: the one whose title named it (on `source`, either), and any other there, which was
 * told the old one. */
async function tellRenamed(source: Target, tree: WorktreeRecord, sessionID: string): Promise<void> {
  await tellWorktree(source, sessionID);
  const told = new Set([sessionID]);
  const places = [source];
  try { places.push(readEngineFile()); } catch {}
  const bridge = bridgeTarget();
  if (bridge) places.push(bridge);
  for (const target of places.filter((each, at) => each.port && places.findIndex(other => other.port === each.port) === at)) {
    for (const session of (await sessionsHere(target, undefined, null))?.sessions ?? []) {
      if (told.has(session.id) || isHiddenRun(session) || !inside(session.location?.directory ?? session.directory, tree.root)) continue;
      told.add(session.id);
      await tellWorktree(target, session.id).catch(() => {});
    }
  }
}

/** A session just made, in one of this box's worktrees or not: its branch named after the title it
 * was made with (an agent's or a bot's, which the engine never says was renamed), and told where it
 * works, by that name. */
export async function settleNewSession(engine: Target, sessionID: unknown): Promise<void> {
  if (!(await nameWorktreeBranch(engine, sessionID))) await tellWorktree(engine, sessionID);
}

/** The worktrees made here whose session has a title by now, named: as they're read, so a reader
 * never sees one before this box named it (it heard of the title a moment later, or wasn't
 * running then), and as this box follows its engine again (a title given meanwhile). */
export async function nameDueWorktrees(engine: Target | null, signal: AbortSignal | undefined): Promise<void> {
  const due = readWorktrees().filter(tree => tree.made && tree.branch === tree.made);
  if (!due.length || !engine?.port) return;
  const sessions = (await sessionsHere(engine, signal))?.sessions ?? [];
  for (const tree of due) {
    const titled = sessions.find(session => (session.location?.directory ?? session.directory) === (tree.folder ?? tree.root) && !isHiddenRun(session) && branchSlug(session.title ?? ""));
    if (titled) await nameWorktreeBranch(engine, titled.id).catch(() => {});
  }
}

/** A session just made in one of this box's worktrees (by a phone, in one it asked for here):
 * told it works there, as a Mac tells one it makes. */
export async function tellWorktree(target: Target, sessionID: unknown): Promise<void> {
  if (typeof sessionID !== "string") return;
  const session: EngineSession | undefined = (await engineGet(target, `api/session/${encodeURIComponent(sessionID)}`) as EngineAnswer<EngineSession>)?.data;
  const folder = session?.location?.directory ?? session?.directory;
  const tree = readWorktrees().find(each => (each.folder ?? each.root) === folder);
  if (!tree) return;
  const told = `You work in a git worktree of this project, on the branch ${tree.branch}, so your changes stay apart from the user's own checkout at ${tree.project} until they merge them. Make your changes here, not there.`;
  await call(target, "PUT", `/api/experimental/session/${encodeURIComponent(sessionID)}/instructions/entries/kuvo.worktree`, { value: told });
}

/** `kuvo/worktrees…`, for this box's own. */
export async function answerWorktrees(method: string, requestPath: string, body: WorktreesBody | null | undefined, engine: Target | null, signal: AbortSignal | undefined, bridge: Target | null = bridgeTarget()): Promise<WorktreesAnswer> {
  const route = requestPath.split("?")[0];
  const message = (text: string) => ({ message: text });
  const list = readWorktrees();
  if (route === "kuvo/worktrees" && method === "GET") {
    // As a Mac reads them (as it connects, and as a session in one gets its title): without what
    // git says, their branches named.
    if (/(^|[?&])records=1(&|$)/.test(requestPath.split("?")[1] ?? "")) {
      await nameDueWorktrees(engine, signal);
      return { status: 200, value: { worktrees: readWorktrees(), restorable: readRestorableWorktrees().map(listedRestorable) } satisfies Worktrees };
    }
    const { sessions, active } = await sessionsHere(engine, signal, bridge) ?? { sessions: [], active: new Set<string>() };
    const worktrees: ListedWorktree[] = [];
    for (const tree of list) {
      const here = sessions.filter(session => inside(session.location?.directory ?? session.directory, tree.root));
      const entry: ListedWorktree = { path: tree.root, folder: tree.folder ?? tree.root, project: tree.project, projectName: path.basename(tree.project), branch: tree.branch, sessions: here.length, working: here.some(session => active.has(session.id)) };
      if (tree.base) entry.base = tree.base;
      if (fs.existsSync(tree.root)) {
        const status = await gitLater(tree.root, ["status", "--porcelain", "--untracked-files=normal", "--ignore-submodules=none"]);
        if (status !== null) {
          entry.uncommitted = status.length > 0;
          const ahead = tree.base ? await gitLater(tree.root, ["rev-list", "--count", `${tree.base}..HEAD`]) : null;
          if (ahead !== null && /^\d+$/.test(ahead)) entry.ahead = Number(ahead);
        }
        const size = await sizeLater(tree.root);
        if (size !== undefined) entry.size = size;
      }
      worktrees.push(entry);
    }
    return { status: 200, value: { worktrees, restorable: readRestorableWorktrees().map(listedRestorable) } satisfies Worktrees };
  }
  if (method !== "POST") return { status: route.startsWith("kuvo/worktrees") ? 405 : 404, value: {} };
  if (route === "kuvo/worktrees") {
    // A new one of a project's repository, on a branch of its own, for a session to run in.
    const project = body?.project;
    if (typeof project !== "string" || !path.isAbsolute(project) || !fs.existsSync(project)) return { status: 400, value: message("Send the project's folder on this machine as {\"project\"}.") };
    if (!engine?.port) return { status: 503, value: message("The engine isn't running.") };
    // What its branch's name starts with: Settings › Git's on this computer.
    // COMPAT(beta.1 worktree-prefix): a Mac's own, sent with each, used as given. Goes when 0.8.0 ships.
    const prefix = typeof body?.branchPrefix === "string" ? body.branchPrefix : branchPrefixHere();
    // Where the project is in its repository, as git sees it (through any links in its path).
    const subpath = gitIn(project, ["rev-parse", "--show-prefix"]);
    if (subpath === null) return { status: 409, value: message("That folder isn't in a git repository.") };
    // One with no commits yet gets its first (empty: what's staged stays so), as a project the box
    // makes does; a branch with none in one with history is yours to begin.
    if (!firstCommit(project)) return { status: 409, value: message("This branch has no commits yet. Make a first commit, then start a session in a worktree.") };
    const base = gitIn(project, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    let id: string | undefined, root: string | undefined;
    try {
      id = await projectOf(engine, project, signal);
      root = (await call(engine, "POST", "/api/worktree", { projectID: id }, signal, project) as { directory?: string } | null)?.directory;
    } catch (error) {
      return { status: 502, value: message((error as Error | null)?.message ?? String(error)) };
    }
    if (typeof root !== "string") return { status: 502, value: message("The engine didn't make it.") };
    // The engine leaves it on no branch; one of its own makes the work easy to commit, push and merge.
    const branch = freeBranch(root, prefix + path.basename(root));
    if (!branch || gitAsked(root, ["switch", "--quiet", "-c", branch]) === null && gitIn(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]) !== branch) {
      await call(engine, "DELETE", "/api/worktree", { projectID: id, directory: root, force: true }, signal, project).catch(() => {});
      // (Most often a prefix git can't use there: `me/` beside a branch named `me`.)
      return { status: 502, value: message(prefix ? `A branch starting with “${prefix}” couldn’t be made in this repository. Change the branch prefix in Settings › Git, then try again.` : "Its branch couldn't be made.") };
    }
    const tree = { project, root, folder: subpath ? path.join(root, subpath.replace(/\/$/, "")) : root, branch, ...(base ? { base } : {}), made: branch, prefix } satisfies WorktreeRecordShape;
    updateWorktrees(list => [...list.filter(each => each.root !== root), tree]);
    return { status: 200, value: tree };
  }
  // COMPAT(0.7 worktrees): a machine's worktrees an older Mac kept, given to its box. Goes 3 months after 0.8.0.
  if (route === "kuvo/worktrees/record") {
    // One a Mac removed before this box kept its records (`removed`): its sessions stay filed under
    // its project. Not over one this box has.
    if (body?.removed === true) {
      const folder = body?.folder, project = body?.project;
      if (typeof folder !== "string" || !path.isAbsolute(folder) || typeof project !== "string" || !path.isAbsolute(project) || folder === project) return { status: 400, value: message("Send {removed: true, project, folder}.") };
      if (!list.some(each => (each.folder ?? each.root) === folder || each.root === folder) && !(folder in readRemovedWorktrees())) updateWorktrees(each => each, { project, root: folder, folder, branch: "" } as WorktreeRecord);
      return { status: 200, value: {} };
    }
    // One a Mac made here before this box kept them: kept here from now on, if it's still here
    // (one removed since, from a phone, say, doesn't come back).
    const given = { project: body?.project, root: body?.root, folder: typeof body?.folder === "string" ? body.folder : body?.root, branch: body?.branch, ...(typeof body?.base === "string" ? { base: body.base } : {}) };
    const absolute = (folder: unknown): folder is string => typeof folder === "string" && path.isAbsolute(folder);
    if (!absolute(given.project) || !absolute(given.root) || !absolute(given.folder) || typeof given.branch !== "string" || !given.branch) return { status: 400, value: message("Send {project, root, folder?, branch, base?}.") };
    if (!fs.existsSync(given.root)) return { status: 404, value: message("That worktree isn't on this machine any more.") };
    // One it has already stays as it keeps it (its branch to be named, say).
    updateWorktrees(list => (list.some(each => each.root === given.root) ? list : [...list, given as WorktreeRecord]));
    return { status: 200, value: {} };
  }
  if (route === "kuvo/worktrees/restore") return restoreTree(body?.folder, engine, signal, bridge);
  const tree = list.find(each => each.root === body?.path);
  if (!tree) return { status: 404, value: message("That worktree isn't on this machine any more.") };
  if (route === "kuvo/worktrees/remove") return removeTree(tree, { discard: body?.discard !== false, forget: body?.forget === true }, engine, signal, bridge);
  return { status: 404, value: {} };
}

/** Whether a session is archived, as a client marks it or the engine does. */
const isArchived = (session: EngineSession) => Boolean(session.time?.archived || session.metadata?.["kuvo.archived"] === true || session.metadata?.kuvo?.archived === true);

/** The folder a session runs in. */
const folderOf = (session: EngineSession) => session.location?.directory ?? session.directory;

/** Where what wasn't committed in `root` is kept as `commit`: a ref of its own for each (a worktree
 * made again in the same folder keeps its own), named so git takes it whatever the folder's called. */
const snapshotRef = (root: string, commit: string) => `refs/kuvo/worktrees/${path.basename(root).replace(/[^A-Za-z0-9_-]+/g, "-")}-${commit.slice(0, 12)}`;

/** The ref kept for `commit` deleted: only while it still names that commit. */
const dropSnapshot = (project: string, root: string, commit: string) => gitIn(project, ["update-ref", "-d", snapshotRef(root, commit), commit]);

/** What isn't committed in `root` kept as a commit on its HEAD (what git ignores left out), under
 * a ref of its own (`snapshotRef`), which outlives the folder: the commit, null when there's nothing
 * to keep, or undefined when it couldn't be kept. Made with an index of its own, so what's staged
 * stays as it is. */
function snapshot(root: string, branch: string): string | null | undefined {
  const status = gitIn(root, ["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"]);
  if (status === null) return undefined;
  if (status === "") return null;
  const gitFolder = gitIn(root, ["rev-parse", "--absolute-git-dir"]);
  if (!gitFolder) return undefined;
  const index = path.join(gitFolder, "kuvo-snapshot-index");
  const env = { GIT_INDEX_FILE: index };
  try {
    // As your own `git add` keeps them, through the repository's filters: what git-crypt keeps
    // encrypted stays so, and what LFS keeps stays out of the repository.
    if (gitAsked(root, ["read-tree", "HEAD"], env) === null || gitAsked(root, ["add", "-A"], env) === null) return undefined;
    const tree = gitIn(root, ["write-tree"], env);
    const commit = tree && gitIn(root, ["commit-tree", tree, "-p", "HEAD", "-m", `What wasn't committed in ${branch} when its worktree was removed`], BY_KUVO);
    if (!commit || gitIn(root, ["update-ref", snapshotRef(root, commit), commit]) === null) return undefined;
    return commit;
  } finally {
    fs.rmSync(index, { force: true });
  }
}

/** A removed one as the records list it. */
function listedRestorable(tree: RestorableWorktree): ListedRestorable {
  const branchThere = fs.existsSync(tree.project) && gitIn(tree.project, ["rev-parse", "--verify", "--quiet", `refs/heads/${tree.branch}`]) !== null;
  const saved = Boolean(tree.snapshot);
  // Its branch merged and gone: made again at the commit it was at, while git still has it.
  const headThere = !branchThere && fs.existsSync(tree.project) && gitIn(tree.project, ["cat-file", "-e", `${tree.head}^{commit}`]) !== null;
  const entry: ListedRestorable = { project: tree.project, root: tree.root, folder: tree.folder ?? tree.root, branch: tree.branch, restorable: branchThere || saved || headThere, saved };
  if (tree.base) {
    entry.base = tree.base;
    const ahead = branchThere ? gitIn(tree.project, ["rev-list", "--count", `${tree.base}..refs/heads/${tree.branch}`]) : null;
    if (ahead !== null && /^\d+$/.test(ahead)) entry.ahead = Number(ahead);
  }
  return entry;
}

/** What `removeTree` is asked: whether what isn't committed goes (`discard`), whether it's one
 * made for a session that never started (`forget`), and whether it's kept for Restore Worktree
 * first (`keep`: a session that ran there stays, archived). */
interface Removal {
  discard: boolean;
  forget?: boolean;
  keep?: boolean;
}

/** `tree` removed: not while an agent works there (nor while that can't be told); with changes not
 * committed only when they're to go, or kept first. Its branch goes only if it's merged. Unless it
 * was made for nothing, it can come back with its sessions (Restore Worktree) while they're here. */
async function removeTree(tree: WorktreeRecord, removal: Removal, engine: Target | null, signal: AbortSignal | undefined, bridge: Target | null, known?: SessionsHere): Promise<WorktreesAnswer> {
  const message = (text: string) => ({ message: text });
  const here = known ?? await sessionsHere(engine, signal, bridge);
  if (!here) return { status: 503, value: message(engine?.port ? `It couldn't be told whether an agent is working in the worktree of ${tree.branch}, so it stays. Try again in a moment.` : `The engine isn't running, so the worktree of ${tree.branch} stays. Try again once it's started.`) };
  const { sessions, active } = here;
  if (sessions.some(session => inside(folderOf(session), tree.root) && active.has(session.id))) {
    return { status: 409, value: message(`An agent is still working in the worktree of ${tree.branch}, so it stays. Stop it first, then remove the worktree.`) };
  }
  // One made for a session that never started (`forget`): not one a session has after all.
  if (removal.forget && sessions.some(session => inside(folderOf(session), tree.root))) {
    return { status: 409, value: message(`A session works in the worktree of ${tree.branch}, so it stays. Remove it with the session, or in Settings › Worktrees.`) };
  }
  const gone = !fs.existsSync(tree.root);
  if (!removal.discard && !removal.keep && !gone && gitIn(tree.root, ["status", "--porcelain", "--untracked-files=normal", "--ignore-submodules=none"]) !== "") {
    return { status: 409, value: message(`The worktree of ${tree.branch} has changes that aren’t committed, so it stays. Commit them, or remove it in Settings › Worktrees, which throws them away.`) };
  }
  if (!engine?.port) return { status: 503, value: message("The engine isn't running.") };
  // Commits on no branch (an agent stopped mid-rebase, say): kept on a branch of their own, as
  // its branch's are.
  const head = gone || gitIn(tree.root, ["symbolic-ref", "--quiet", "HEAD"]) !== null ? null : gitIn(tree.root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  let branch = tree.branch;
  if (head && !gitIn(tree.root, ["for-each-ref", "--contains", head, "--format=%(refname)", "refs/heads"])) {
    const kept = freeBranch(tree.root, `${tree.branch}-kept`);
    if (!kept || gitIn(tree.root, ["branch", kept, head]) === null) return { status: 409, value: message(`The worktree of ${tree.branch} has commits on no branch, and they couldn’t be kept on one, so it stays.`) };
    branch = kept;
  }
  // What it's at, and what isn't committed, kept for Restore Worktree.
  const at = gone ? gitIn(tree.project, ["rev-parse", "--verify", "--quiet", `refs/heads/${tree.branch}`]) : gitIn(tree.root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const saved = removal.keep && !gone ? snapshot(tree.root, tree.branch) : null;
  if (saved === undefined) return { status: 409, value: message(`What isn’t committed in the worktree of ${tree.branch} couldn’t be kept, so it stays.`) };
  try {
    if (gone) {
      // Its folder deleted by hand: the engine won't remove what isn't there, so git forgets it.
      if (fs.existsSync(tree.project)) gitIn(tree.project, ["worktree", "prune"]);
    } else {
      const force = removal.discard || removal.keep;
      if (tree.restored) {
        // Restored here, git made it, so the engine doesn't know it: git removes it.
        const refused = spawnGit(tree.project, ["worktree", "remove", ...(force ? ["--force"] : []), tree.root]);
        if (refused !== null) throw new Error(refused);
      } else {
        const id = await projectOf(engine, tree.project, signal);
        await call(engine, "DELETE", "/api/worktree", { projectID: id, directory: tree.root, force }, signal, tree.project);
      }
    }
  } catch (error) {
    if (saved) dropSnapshot(tree.project, tree.root, saved);
    return { status: 502, value: message((error as Error | null)?.message ?? String(error)) };
  }
  // Its branch goes only if it's merged (made for nothing, it goes whatever: `forget`).
  gitIn(tree.project, ["branch", removal.forget ? "-D" : "-d", tree.branch]);
  const restorable: RestorableWorktree | null = removal.forget || !at ? null : { ...tree, branch, head: at, ...(saved ? { snapshot: saved } : {}) };
  updateWorktrees(list => list.filter(each => each.root !== tree.root), tree, list => [...list.filter(each => each.root !== tree.root), ...(restorable ? [restorable] : [])]);
  return { status: 200, value: {} };
}

/** The worktree whose sessions ran in `folder`, removed, brought back where it was: on its branch
 * (made again at the commit it was at, if it went), with what wasn't committed back as it was, not
 * committed. Answers it as the box keeps it again. */
async function restoreTree(folder: unknown, engine: Target | null, signal: AbortSignal | undefined, bridge: Target | null): Promise<WorktreesAnswer> {
  const message = (text: string) => ({ message: text });
  const tree = readRestorableWorktrees().find(each => (each.folder ?? each.root) === folder || each.root === folder);
  if (!tree) return { status: 404, value: message("It can’t come back any more.") };
  if (!fs.existsSync(tree.project)) return { status: 409, value: message("Its project folder is gone.") };
  if (fs.existsSync(tree.root) && fs.readdirSync(tree.root).length) return { status: 409, value: message("Something else is in its folder now.") };
  const saved = tree.snapshot && gitIn(tree.project, ["cat-file", "-e", `${tree.snapshot}^{commit}`]) !== null ? tree.snapshot : undefined;
  const branchThere = gitIn(tree.project, ["rev-parse", "--verify", "--quiet", `refs/heads/${tree.branch}`]) !== null;
  const headThere = gitIn(tree.project, ["cat-file", "-e", `${tree.head}^{commit}`]) !== null;
  if (!branchThere && !saved && !headThere) return { status: 409, value: message("Its work is gone, so it can’t come back.") };
  gitIn(tree.project, ["worktree", "prune"]);
  const made = branchThere
    ? spawnGit(tree.project, ["worktree", "add", tree.root, tree.branch])
    : spawnGit(tree.project, ["worktree", "add", "-b", tree.branch, tree.root, tree.head]);
  if (made !== null) {
    // Nothing of it left half made: the branch made for it goes too.
    if (fs.existsSync(tree.root)) gitIn(tree.project, ["worktree", "remove", "--force", tree.root]);
    if (!branchThere) gitIn(tree.project, ["branch", "-D", tree.branch]);
    return { status: 409, value: message(made.includes("already") && made.includes("checked out") ? `${tree.branch} is open in another folder.` : "Its folder couldn’t be made again.") };
  }
  // What wasn't committed, back as it was: straight onto the commit it was kept on, or merged
  // onto the branch as it is now. Kept until it's back.
  if (saved) {
    const onto = gitIn(tree.root, ["rev-parse", "HEAD"]);
    const parent = gitIn(tree.root, ["rev-parse", `${saved}^`]);
    const back = onto === parent
      ? gitAsked(tree.root, ["read-tree", "-m", "-u", "HEAD", saved]) !== null
      : gitAsked(tree.root, ["cherry-pick", "--no-commit", saved], BY_KUVO) !== null;
    if (!back) {
      gitAsked(tree.root, ["cherry-pick", "--abort"]);
      gitAsked(tree.root, ["reset", "--quiet", "--hard", "HEAD"]);
      gitIn(tree.project, ["worktree", "remove", "--force", tree.root]);
      if (!branchThere) gitIn(tree.project, ["branch", "-D", tree.branch]);
      return { status: 409, value: message(`Its saved changes clash with newer work on ${tree.branch}.`) };
    }
    // What was staged comes back as changes not staged: the snapshot keeps one tree for both.
    gitAsked(tree.root, ["reset", "--quiet"]);
  }
  const { head: _head, snapshot: _snapshot, made: _made, prefix: _prefix, ...kept } = tree;
  // Not used again until a session there is open: with them all archived, the next sweep would only
  // remove it again.
  const record: WorktreeRecord = { ...kept, used: false, restored: true };
  updateWorktrees(list => [...list.filter(each => each.root !== tree.root), record], undefined, list => list.filter(each => each.root !== tree.root));
  if (saved) dropSnapshot(tree.project, tree.root, saved);
  // Its sessions told where they work again, as they were.
  const here = await sessionsHere(engine, signal, bridge);
  for (const session of here?.sessions ?? []) {
    if (!inside(folderOf(session), tree.root) || isHiddenRun(session)) continue;
    // (Whichever has it: the other has no such session.)
    for (const target of [engine, bridge]) if (target?.port) await tellWorktree(target, session.id).catch(() => {});
  }
  return { status: 200, value: record };
}

/** git in `folder` doing what you asked for (making or removing a worktree, with the repository's
 * hooks and filters): null when it did it, or what it said when it didn't. */
function spawnGit(folder: string, args: string[]): string | null {
  const asked = askedArgs(args, folder);
  if (!asked) return "This repository’s commondir leads git to another repository’s settings, so Kuvo Code won’t run git there.";
  const ran = spawnSync("git", asked, { cwd: folder, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeout: 60_000 });
  return ran.status === 0 ? null : String(ran.stderr || ran.stdout || "").trim().replace(/^fatal: /, "");
}

/** A sweep running now, and whether another was asked for meanwhile. */
let sweeping: Promise<void> | null = null;
let sweepAgain = false;

/** This box's worktrees tidied as its sessions go (PROTOCOL.md, "Worktrees"): one a session has
 * run in goes once no session left in it is anything but archived, and none is at work there,
 * whoever archived or deleted it (a Mac, a phone, a bot). What isn't committed in it is kept for
 * Restore Worktree while an archived session is there to bring it back; a removed one whose
 * sessions have all gone can't come back, and what was kept for it goes. Runs as a session is
 * archived or deleted, and as this box follows its engine again. `engine`, `bridge`: where its
 * sessions are (this box's own engine, unless given). */
export function tidyWorktrees(signal?: AbortSignal, engine?: Target | null, bridge?: Target | null): Promise<void> {
  if (sweeping) {
    sweepAgain = true;
    return sweeping;
  }
  sweeping = (async () => {
    do {
      sweepAgain = false;
      await sweep(signal, engine, bridge).catch(() => {});
    } while (sweepAgain && !signal?.aborted);
  })().finally(() => { sweeping = null; });
  return sweeping;
}

async function sweep(signal: AbortSignal | undefined, given: Target | null | undefined, givenBridge: Target | null | undefined): Promise<void> {
  if (!readWorktrees().length && !readRestorableWorktrees().length) return;
  let engine = given ?? null;
  if (given === undefined) try { engine = readEngineFile(); } catch {}
  let bridge = givenBridge ?? null;
  if (givenBridge === undefined) {
    // The coding agents' sessions are the bridge's: while it's down (restarting, say), whether a
    // worktree is still theirs can't be told.
    let record: { port?: number } | null = null;
    try { record = readBridgeFile(); } catch {}
    bridge = bridgeTarget();
    if (record?.port && !bridge) return;
  }
  const here = await sessionsHere(engine, signal, bridge);
  if (!here) return;
  const ranIn = (root: string, seen: SessionsHere = here) => seen.sessions.filter(session => !isHiddenRun(session) && !session.parentID && inside(folderOf(session), root));
  // Ones a session runs in now, marked: an older one, from before this box marked them, by any
  // session there; one restored, by an open one (with them all archived it would only go again).
  const used = readWorktrees().filter(tree => (tree.used === undefined ? ranIn(tree.root).length : !tree.used && ranIn(tree.root).some(session => !isArchived(session)))).map(tree => tree.root);
  if (used.length) updateWorktrees(list => list.map(each => (used.includes(each.root) ? { ...each, used: true } : each)));
  const goes = (tree: WorktreeRecord, seen: SessionsHere) => {
    const sessions = ranIn(tree.root, seen);
    // (One restored, waiting for a session there to be open, goes once there's none.)
    return (tree.used || (tree.used === false && !sessions.length)) && !sessions.some(session => !isArchived(session) || seen.active.has(session.id));
  };
  for (const tree of readWorktrees()) {
    if (!goes(tree, here)) continue;
    // Read again right before: a session there may have been opened, or an agent started, since.
    const now = await sessionsHere(engine, signal, bridge);
    if (!now || !goes(tree, now)) continue;
    const left = ranIn(tree.root, now).length;
    // With an archived one left, it can come back; with none, what isn't committed goes with it.
    await removeTree(tree, { discard: !left, keep: left > 0 }, engine, signal, bridge, now).catch(() => {});
  }
  // Removed ones with no session left to bring them back: what was kept for them goes.
  const orphans = readRestorableWorktrees().filter(tree => !ranIn(tree.root).length);
  if (!orphans.length) return;
  for (const tree of orphans) if (tree.snapshot && fs.existsSync(tree.project)) dropSnapshot(tree.project, tree.root, tree.snapshot);
  updateWorktrees(list => list, undefined, list => list.filter(each => !orphans.some(gone => gone.root === each.root)));
}

// Where its engine keeps what's its own (its XDG_DATA_HOME's `opencode`): in this box's folder on
// a machine, and in the app's on a Mac (KUVO_ENGINE_DATA). New worktrees go in its `worktree`
// folder, unless Settings › Worktrees names another.

/** `kuvo/worktrees/where`: where new worktrees go with `directory` as Settings' Worktrees folder
 * (none: the engine's own), as the engine reads it, for each of this box's projects in a git
 * repository: the folder, whether it's there or can be made, and whether it's in the repository's
 * own checkout without git ignoring it (git would list them all as new files there). A relative
 * one starts at the repository's own checkout, not at the project's folder in it. */
export async function worktreesWhere(directory: unknown, engine: Target | null, signal: AbortSignal | undefined, projects: string[] = readProjects().filter(each => !each.removed).map(each => each.directory)) {
  const value = typeof directory === "string" && directory !== "" ? directory : null;
  const answer: Omit<WorktreesWhere, "projects"> & { projects: WhereProject[] } = { directory: value, default: path.join(ENGINE_DATA, "worktree"), home: homeFolder(), projects: [] };
  // The engine's projects, by their own checkout, from one call about none of them (one about a
  // folder would start the engine there): their ids name the engine's own folders.
  const ids = new Map<string, string | null>();
  if (engine?.port) {
    try {
      for (const known of (await call(engine, "GET", "/api/project", undefined, signal)) as ({ id?: unknown; canonical?: unknown; vcs?: unknown } | null)[]) {
        if (typeof known?.id === "string" && typeof known?.canonical === "string") ids.set(realOr(known.canonical), known.vcs === "git" && known.id !== "global" ? known.id : null);
      }
    } catch {}
  }
  for (const project of projects) {
    if (!fs.existsSync(project)) continue;
    // The repository's own checkout (of a worktree, or of a folder in it, its main one), which
    // the engine resolves a relative folder from. (Without --path-format, which older git lacks.)
    const common = await gitLater(project, ["rev-parse", "--git-common-dir"]);
    if (!common) continue;
    const gitFolder = path.resolve(project, common);
    if (path.basename(gitFolder) !== ".git") continue;
    const checkout = realOr(path.dirname(gitFolder));
    // One the engine doesn't take for a repository has no worktrees: a repository with no commit
    // yet is its "global" project (asked of git when the engine hasn't said).
    const id = ids.get(checkout);
    if (id === null || (id === undefined && !(await gitLater(project, ["rev-list", "-n", "1", "--all"])))) continue;
    // The engine's own: a folder for each project, named by the start of its id.
    const folder = value === null ? (id ? path.join(answer.default, id.slice(0, 6)) : null)
      : value.startsWith("~/") ? path.join(answer.home, value.slice(2)) : path.resolve(checkout, value);
    const entry: WhereProject = { project, name: path.basename(project), folder };
    if (folder) {
      entry.exists = (() => { try { return fs.statSync(folder).isDirectory(); } catch { return false; } })();
      if (!entry.exists) entry.canMake = canMake(folder);
      if (inside(folder, checkout)) {
        entry.inside = true;
        // What's in it, as git sees a worktree there: ignored, or a new folder in the checkout.
        entry.ignored = (await gitLater(checkout, ["check-ignore", "-q", path.join(folder, "worktree")])) !== null;
      }
    }
    answer.projects.push(entry);
  }
  apart(answer.projects, answer.home);
  return answer;
}

/** Projects that share a name, told apart by the folders they're in, as few as it takes:
 * "sums — scratchpad" and "sums — code" (the home folder as "~"). */
function apart(projects: WhereProject[], home: string): void {
  const parents = (project: string) => {
    const folder = path.dirname(project);
    const inHome = folder === home || folder.startsWith(home + path.sep);
    const names = (inHome ? folder.slice(home.length) : folder).split(path.sep).filter(Boolean);
    return (inHome ? ["~", ...names] : names).reverse();
  };
  for (const name of new Set(projects.map(each => each.name))) {
    const same = projects.filter(each => each.name === name);
    if (same.length < 2) continue;
    const longest = Math.max(...same.map(each => parents(each.project).length));
    for (let depth = 1; depth <= longest; depth++) {
      const labels = same.map(each => parents(each.project).slice(0, depth).reverse().join("/"));
      if (new Set(labels).size === same.length || depth === longest) {
        same.forEach((each, at) => { if (labels[at]) each.name = `${name} — ${labels[at]}`; });
        break;
      }
    }
  }
}

/** A folder through any links in its path, as the engine names a checkout; as it is when it isn't there. */
function realOr(folder: string): string {
  try { return fs.realpathSync(folder); } catch { return folder; }
}

/** Whether `folder` can be made: the nearest folder of it that's there is one you can write in. */
function canMake(folder: string): boolean {
  for (let at = path.dirname(folder); ; at = path.dirname(at)) {
    try {
      if (!fs.statSync(at).isDirectory()) return false;
      fs.accessSync(at, fs.constants.W_OK);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT" || at === path.dirname(at)) return false;
    }
  }
}

// Its worktrees' records followed, with those removed whose sessions are still here: a line now,
// and again each time they change (one made for a phone, renamed, removed, restored), as a Mac
// shows them.
export async function* worktreeEventsRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, signal, json } = context;
  if (request.method.toUpperCase() !== "GET") return yield* json(405, {});
  yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
  return yield* followed(() => ({ worktrees: readWorktrees(), restorable: readRestorableWorktrees().map(listedRestorable) }), worktreeFollowers, signal);
}

// Settings › Worktrees, and a new session's worktree (PROTOCOL.md, "Worktrees").
export async function* worktreesRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, signal, route, readEngine, json } = context;
  let engine: EngineRecord | null = null;
  try { engine = readEngine(); } catch {}
  if (route === "kuvo/worktrees/where") {
    if (request.method.toUpperCase() !== "GET") return yield* json(405, {});
    return yield* json(200, await worktreesWhere(new URLSearchParams(request.path.split("?")[1] ?? "").get("directory"), engine, signal));
  }
  const { status, value } = await answerWorktrees(request.method.toUpperCase(), request.path, parsed(request.body) as WorktreesBody | null | undefined, engine, signal);
  return yield* json(status, value);
}

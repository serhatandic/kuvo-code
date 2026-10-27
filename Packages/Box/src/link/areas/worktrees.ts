// Worktrees (PROTOCOL.md, "Worktrees"): the git worktrees sessions here run in, each on a
// branch of its own, kept by this box (`box/worktrees.json`): made, named after their session,
// listed and removed here, from a Mac (through `box route`) or a phone, with the Mac closed too.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parsed } from "../../shared/json";
import type { Fields } from "../../shared/json";
import type { EngineRecord, Target } from "../../shared/records";
import type { ListedWorktree, WorktreeRecordShape, Worktrees, WorktreesWhere } from "../../shared/routes/worktrees";
import { call, engineGet } from "../engine/client";
import type { EngineAnswer } from "../engine/client";
import { isHiddenRun } from "../engine/sessions";
import type { EngineSession } from "../engine/sessions";
import { writePrivate } from "../files";
import { followed } from "../follow";
import { gitIn, gitLater, sizeLater } from "../git";
import { ENGINE_DATA } from "../home";
import type { AnswerPiece, JSONAnswer, RouteContext } from "../server/context";
import { readProjects } from "./projects";
import { BRANCH_PREFIX_FILE, branchPrefix, readWorktrees, updateWorktrees, worktreeFollowers } from "./worktree-records";
import type { WorktreeRecord } from "./worktree-records";

/** Sessions by the folder they run in, and which are at work (their ids). */
interface SessionsHere {
  sessions: EngineSession[];
  active: Set<string>;
}

/** What a client sends `kuvo/worktrees…`, as it comes: a new one's project and branch prefix, one
 * an older Mac kept, or one to remove (`path`, `forget`, `discard`). Each is checked as it's used. */
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
}

/** What `kuvo/worktrees…` answers: the list, one just made, `{}` for done (or nothing to say), or
 * why not. */
export type WorktreesAnswer = JSONAnswer<Worktrees | WorktreeRecordShape | { message: string } | Record<string, never>>;

/** A project as `kuvo/worktrees/where` tells of it. */
type WhereProject = WorktreesWhere["projects"][number];

/** `name`, or `name-2` and so on when that's a branch already, as the Mac's Git.newBranch picks. */
function freeBranch(folder: string, name: string): string | null {
  for (let suffix = 1; suffix <= 20; suffix++) {
    const candidate = suffix === 1 ? name : `${name}-${suffix}`;
    if (gitIn(folder, ["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`]) === null) return candidate;
  }
  return null;
}

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

/** Sessions by the folder they run in, and which are at work, as its engine has them; none when it can't say. */
async function sessionsHere(engine: Target | null, signal: AbortSignal | undefined): Promise<SessionsHere> {
  if (!engine?.port) return { sessions: [], active: new Set() };
  const headers = { authorization: `Basic ${Buffer.from(`opencode:${engine.password}`).toString("base64")}` };
  try {
    const listed = await fetch(`http://127.0.0.1:${engine.port}/api/session?parentID=null&limit=200&order=desc`, { headers, signal: AbortSignal.timeout(10_000) });
    // (As the engine answers it: its sessions, each whole.)
    const sessions = listed.ok ? ((await listed.json()) as { data?: EngineSession[] } | null)?.data ?? [] : [];
    const busy = await fetch(`http://127.0.0.1:${engine.port}/api/session/active`, { headers, signal: AbortSignal.timeout(10_000) });
    const active = new Set(Object.keys(busy.ok ? ((await busy.json()) as { data?: Record<string, unknown> } | null)?.data ?? {} : {}));
    return { sessions, active };
  } catch {
    return { sessions: [], active: new Set() };
  }
}

const inside = (folder: string | undefined, root: string) => folder === root || folder?.startsWith(root + "/");

/** `tree`'s branch named `to` (or `to-2` and so on), unless it's been pushed: whether it was. */
function renameWorktree(tree: WorktreeRecord, to: string): boolean {
  if (gitIn(tree.root, ["rev-parse", "--abbrev-ref", `${tree.branch}@{upstream}`]) !== null) return false;
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
 * not pushed. Its session is told the new name, as it was told the one before. */
export async function nameWorktreeBranch(engine: Target, sessionID: unknown): Promise<void> {
  if (typeof sessionID !== "string") return;
  const session: EngineSession | undefined = (await engineGet(engine, `api/session/${encodeURIComponent(sessionID)}`) as EngineAnswer<EngineSession>)?.data;
  // Not after a subagent's title, nor an engine run's a coding agent's session started.
  if (!session || session.parentID || isHiddenRun(session)) return;
  const folder = session.location?.directory ?? session.directory;
  // Read now, after the wait: what another naming did meanwhile shows.
  const tree = readWorktrees().find(each => (each.folder ?? each.root) === folder);
  const slug = branchSlug(session.title ?? "");
  if (!tree?.made || tree.branch !== tree.made || !slug) return;
  if (renameWorktree(tree, (tree.prefix ?? "") + slug)) await tellWorktree(engine, sessionID);
}

/** The worktrees made here whose session has a title by now, named: as they're read, so a reader
 * never sees one before this box named it (it heard of the title a moment later, or wasn't
 * running then). */
async function nameDueWorktrees(engine: Target | null, signal: AbortSignal | undefined): Promise<void> {
  const due = readWorktrees().filter(tree => tree.made && tree.branch === tree.made);
  if (!due.length || !engine?.port) return;
  const { sessions } = await sessionsHere(engine, signal);
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
export async function answerWorktrees(method: string, requestPath: string, body: WorktreesBody | null | undefined, engine: Target | null, signal: AbortSignal | undefined): Promise<WorktreesAnswer> {
  const route = requestPath.split("?")[0];
  const message = (text: string) => ({ message: text });
  const list = readWorktrees();
  if (route === "kuvo/worktrees" && method === "GET") {
    // As a Mac reads them (as it connects, and as a session in one gets its title): without what
    // git says, their branches named.
    if (/(^|[?&])records=1(&|$)/.test(requestPath.split("?")[1] ?? "")) {
      await nameDueWorktrees(engine, signal);
      return { status: 200, value: { worktrees: readWorktrees() } satisfies Worktrees };
    }
    const { sessions, active } = await sessionsHere(engine, signal);
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
    return { status: 200, value: { worktrees } satisfies Worktrees };
  }
  if (method !== "POST") return { status: route.startsWith("kuvo/worktrees") ? 405 : 404, value: {} };
  if (route === "kuvo/worktrees") {
    // A new one of a project's repository, on a branch of its own, for a session to run in.
    const project = body?.project;
    if (typeof project !== "string" || !path.isAbsolute(project) || !fs.existsSync(project)) return { status: 400, value: message("Send the project's folder on this machine as {\"project\"}.") };
    if (!engine?.port) return { status: 503, value: message("The engine isn't running.") };
    // What its branch's name starts with: as given, and kept for a client that doesn't say (a
    // phone), so one made from there starts as yours do.
    const kept = branchPrefix();
    const prefix = typeof body?.branchPrefix === "string" ? body.branchPrefix : kept;
    // Where the project is in its repository, as git sees it (through any links in its path).
    const subpath = gitIn(project, ["rev-parse", "--show-prefix"]);
    if (subpath === null) return { status: 409, value: message("That folder isn't in a git repository.") };
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
    if (!branch || gitIn(root, ["switch", "--quiet", "-c", branch]) === null && gitIn(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]) !== branch) {
      await call(engine, "DELETE", "/api/worktree", { projectID: id, directory: root, force: true }, signal, project).catch(() => {});
      return { status: 502, value: message("Its branch couldn't be made.") };
    }
    // The prefix it was made with, kept for a client that gives none, once a branch with it was made.
    if (prefix !== kept) writePrivate(BRANCH_PREFIX_FILE, JSON.stringify({ branchPrefix: prefix }));
    const tree = { project, root, folder: subpath ? path.join(root, subpath.replace(/\/$/, "")) : root, branch, ...(base ? { base } : {}), made: branch, prefix } satisfies WorktreeRecordShape;
    updateWorktrees(list => [...list.filter(each => each.root !== root), tree]);
    return { status: 200, value: tree };
  }
  // COMPAT(0.7 worktrees): a machine's worktrees an older Mac kept, given to its box. Goes 3 months after 0.8.0.
  if (route === "kuvo/worktrees/record") {
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
  const tree = list.find(each => each.root === body?.path);
  if (!tree) return { status: 404, value: message("That worktree isn't on this machine any more.") };
  if (route === "kuvo/worktrees/remove") {
    // Not while an agent works there; with changes not committed only when they're to go.
    const { sessions, active } = await sessionsHere(engine, signal);
    if (sessions.some(session => inside(session.location?.directory ?? session.directory, tree.root) && active.has(session.id))) {
      return { status: 409, value: message(`An agent is still working in the worktree of ${tree.branch}, so it stays. Stop it first, then remove the worktree.`) };
    }
    // One made for a session that never started (`forget`): not one a session has after all.
    if (body?.forget === true && sessions.some(session => inside(session.location?.directory ?? session.directory, tree.root))) {
      return { status: 409, value: message(`A session works in the worktree of ${tree.branch}, so it stays. Remove it with the session, or in Settings › Worktrees.`) };
    }
    const discard = body?.discard !== false;
    if (!discard && fs.existsSync(tree.root) && gitIn(tree.root, ["status", "--porcelain", "--untracked-files=normal", "--ignore-submodules=none"]) !== "") {
      return { status: 409, value: message(`The worktree of ${tree.branch} has changes that aren’t committed, so it stays. Commit them, or remove it in Settings › Worktrees, which throws them away.`) };
    }
    if (!engine?.port) return { status: 503, value: message("The engine isn't running.") };
    try {
      const id = await projectOf(engine, tree.project, signal);
      await call(engine, "DELETE", "/api/worktree", { projectID: id, directory: tree.root, force: discard }, signal, tree.project);
    } catch (error) {
      return { status: 502, value: message((error as Error | null)?.message ?? String(error)) };
    }
    // Its branch goes only if it's merged (made for nothing, it goes whatever: `forget`).
    gitIn(tree.project, ["branch", body?.forget === true ? "-D" : "-d", tree.branch]);
    updateWorktrees(list => list.filter(each => each.root !== tree.root), tree);
    return { status: 200, value: {} };
  }
  return { status: 404, value: {} };
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
  const answer: Omit<WorktreesWhere, "projects"> & { projects: WhereProject[] } = { directory: value, default: path.join(ENGINE_DATA, "worktree"), home: os.homedir(), projects: [] };
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
    // yet is its "global" project (left out with the engine stopped too).
    const id = ids.get(checkout);
    if (id === null || (await gitLater(project, ["rev-parse", "-q", "--verify", "HEAD"])) === null) continue;
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
  apart(answer.projects);
  return answer;
}

/** Projects that share a name, told apart by the folders they're in, as few as it takes:
 * "sums — scratchpad" and "sums — code". */
function apart(projects: WhereProject[]): void {
  const parents = (project: string) => path.dirname(project).split(path.sep).filter(Boolean).reverse();
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

// Its worktrees' records followed: a line now, and again each time they change (one made for
// a phone, renamed, removed), as a Mac shows them.
export async function* worktreeEventsRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, signal, json } = context;
  if (request.method.toUpperCase() !== "GET") return yield* json(405, {});
  yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
  return yield* followed(() => ({ worktrees: readWorktrees() }), worktreeFollowers, signal);
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

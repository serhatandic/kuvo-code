// Projects: the box's own list (PROTOCOL.md, "Projects"), which every client reads and changes here.

import fs from "node:fs";
import path from "node:path";
import { isObject, parsed } from "../../shared/json";
import { processRuns as runs } from "../../shared/platform";
import { withNotes } from "../../shared/session-notes";
import type { BridgeRecord, EngineRecord, Target } from "../../shared/records";
import type { Project, Projects } from "../../shared/routes/projects";
import { call, readBridgeFile, readEngineFile } from "../engine/client";
import { rewriteOn } from "../engine/notes";
import { isHiddenRun, type EngineSession } from "../engine/sessions";
import { askedAbout, realish } from "../fence/policy";
import { holdsBack, permissionsHere } from "../bots/tell";
import { heldOf } from "../work/approval";
import { locked, writePrivate } from "../files";
import { followed } from "../follow";
import { K } from "../home";
import type { AnswerPiece, LinkRequest } from "../server/context";
import type { KitRule } from "../bots/kit";
import { holdArchived } from "./wakes";
import { stopIfWaiting } from "../work/answers";
import { worktreeFollowers, worktreeProjects } from "./worktree-records";
import { linkedFollowers, linkedTreesOf } from "../work/project-trees";

export const PROJECTS_FILE = path.join(K, "box", "projects.json");
const PROJECTS_LOCK = PROJECTS_FILE + ".lock";

/** A project New Bot offers here: its folder and its name. */
export interface OfferedProject {
  directory: string;
  name: string;
}

/** A page of the engine's sessions (`api/session`), and where the next page starts. */
interface SessionPage {
  data?: EngineSession[];
  cursor?: { next?: string };
}

/** Read saved projects without the retired terminal setting. Migration takes the same lock as
 * edits, and rereads there so a simultaneous client edit is never overwritten. */
export function readProjects(file = PROJECTS_FILE, migrate = true): Project[] {
  const read = () => {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    let changed = false;
    if (!Array.isArray(saved.projects)) return { saved, projects: [], changed };
    for (const project of saved.projects) {
      if (isObject(project) && "terminal" in project) {
        delete project.terminal;
        changed = true;
      }
    }
    const projects = saved.projects
      .filter((each: Project) => typeof each?.directory === "string" && path.isAbsolute(each.directory))
      .map((each: Project) => ({ ...each, folders: Array.isArray(each.folders) ? each.folders.filter((folder: unknown) => typeof folder === "string") : [] }));
    return { saved, projects, changed };
  };
  try {
    const first = read();
    if (!first.changed || !migrate) return first.projects;
    try {
      return locked(file + ".lock", () => {
        const latest = read();
        if (latest.changed) writePrivate(file, JSON.stringify(latest.saved, null, 2));
        return latest.projects;
      });
    } catch {
      // A read-only disk must still let the client open all its existing projects.
      return first.projects;
    }
  } catch {
    return [];
  }
}

/** The instruction entry a session in a project of several folders gets, naming them. */
export const PROJECT_FOLDERS_ENTRY = "kuvo.project-folders";

/** What a session in a project of several folders is told of them (`PROJECT_FOLDERS_ENTRY`), as
 * the Mac told it (ProjectFolders.instructions). */
export const projectFoldersNote = (primary: string, folders: readonly string[]): string =>
  `This project spans several folders. You work in its primary folder, ${path.basename(primary)} (${primary}). These folders belong to the project too, and you can read, search and change files in them the same way:\n${folders.map(folder => `- ${path.basename(folder)}: ${folder}`).join("\n")}\nWhen the user mentions one of these folders by name, they mean that folder.`;

/** A project's other folders as a session in `folder` gets them: those of the project it's the
 * primary folder of, or a worktree of; none for one in one of those other folders (or a worktree of
 * one), which works there alone, nor for a chat or a folder that's no project. */
export function foldersFor(folder: string, projects: Project[] = readProjects()): readonly string[] {
  return listedFolders(folder, projects) ?? [];
}

/** The folders of a project the box lists as a client set them; null for one it added itself
 * (`addedByBox`: as a session started there, or `make_project`), which no client has set yet,
 * unless `added` (a session moved there: its folders, none yet, are the box's to say). */
const setFolders = (project: Project | undefined, added = false): readonly string[] | null => (project && (added || !project.addedByBox) ? project.folders : null);

/** As `foldersFor`, but null where the box doesn't list the project `folder` is in (or a worktree
 * of), or no client has set its folders yet (`addedByBox`): one it doesn't know (a Mac from before
 * keeps its projects itself, or hasn't handed them over yet), whose folders aren't the box's to
 * say. */
function listedFolders(folder: string, projects: Project[] = readProjects(), added = false): readonly string[] | null {
  const directory = worktreeProjects()[folder] ?? folder;
  const own = projects.find(each => each.directory === directory);
  if (own) {
    const folders = setFolders(own, added);
    return folders && (folders.includes(folder) ? [] : folders);
  }
  // (One of a listed project's other folders, or a worktree of one: it works there alone.)
  return projects.some(each => setFolders(each)?.includes(directory)) ? [] : null;
}

/** The rules allowing a project's other folders, symlinks resolved too (`/var` is `/private/var`):
 * after its approval's rules, as the last rule that matches wins and Ask First asks about any
 * folder. */
export function folderRules(folders: readonly string[]): KitRule[] {
  const paths: string[] = [];
  for (const folder of folders) {
    let real = folder;
    try { real = fs.realpathSync(folder); } catch {}
    for (const each of [folder, real]) if (!paths.includes(each)) paths.push(each);
  }
  return paths.map(each => ({ action: "external_directory", resource: path.join(each, "*"), effect: "allow" }));
}

/** A rule allowing one folder (its project's, a bot's own). */
export const isFolderRule = (rule: KitRule): boolean => rule.action === "external_directory" && rule.effect === "allow" && rule.resource.endsWith("/*");

/** `rules` with the folders they allow made `folders`: a bot's own folder stays allowed, as it isn't
 * one of the project's, and one Settings › Permissions names is Settings' to say (Auto and Full
 * Access allow what it asks about outside; a Don't Allow there holds), as a session's rules are
 * made (`refreshedRules`). Don't Allows its lead brought from another computer (`held`) stay last,
 * so no folder allowed here lets it past them. */
export function withFolders(rules: readonly KitRule[], folders: readonly string[], held: readonly KitRule[] = []): KitRule[] {
  const same = (one: KitRule, other: KitRule) => one.action === other.action && one.resource === other.resource;
  const named = settingsFolderRules(rules);
  // (Settings' rules for the folder a rule names, by where it really is: a link and where it leads
  // are one folder, and `folderRules` allows both.)
  const namedAt = (rule: KitRule) => {
    const at = folderNamed(rule.resource);
    return named.filter(each => folderNamed(each.resource) === at);
  };
  const adding = projectFolderRules(folders, rules);
  const last = rules.filter(rule => held.some(each => same(each, rule) && each.effect === rule.effect));
  // (A folder allowed because Settings asks about it, in Auto and Full Access, which allow what it
  // asks about; never in an approval that asks first, nor one Settings doesn't allow now, which an
  // allow from before would let past it.)
  const asksFirst = rules.some(rule => rule.action === "shell" && rule.resource === "*" && rule.effect === "ask");
  const asked = (rule: KitRule) => !asksFirst && namedAt(rule).at(-1)?.effect === "ask";
  const kept = rules.filter(rule => !last.includes(rule) && !(rule.effect === "allow" && adding.some(each => same(each, rule)))
    && (!isFolderRule(rule) || rule.resource.includes("/bots/bot_") || asked(rule)));
  return [...kept, ...adding, ...last];
}

/** Settings › Permissions' rules for folders outside (or, where its Settings are its Mac's, the
 * Don't Allows a session's `rules` carry from them). */
const settingsFolderRules = (rules: readonly KitRule[]): KitRule[] => (permissionsHere() ?? rules.filter(holdsBack)).filter(rule => rule.action === "external_directory");

/** The folder a rule names (`<folder>/*`), where it really is; any other resource as it is. */
const folderNamed = (resource: string): string => (resource.endsWith("/*") ? realish(resource.slice(0, -2)) : resource);

/** The rules allowing a project's other folders (`folderRules`) but those Settings › Permissions
 * names, by where they really are (a link and where it leads are one folder): those are Settings' to
 * say, as `refreshedRules` has them. `rules`: the session's, whose Don't Allows are Settings' where
 * this box's aren't its own. */
export function projectFolderRules(folders: readonly string[], rules: readonly KitRule[] = []): KitRule[] {
  const named = new Set(settingsFolderRules(rules).map(rule => folderNamed(rule.resource)));
  return folderRules(folders).filter(rule => !named.has(folderNamed(rule.resource)));
}

/** The folders Settings › Permissions' rules name (or a session's own `rules`), to ask macOS about
 * before they're looked at where they really are (`askedAbout`). */
export const namedFolders = (rules: readonly KitRule[] = []): string[] =>
  [...settingsFolderRules(rules), ...rules].filter(rule => rule.action === "external_directory" && rule.resource.endsWith("/*")).map(rule => rule.resource.slice(0, -2));

/** The other folders a session in `at` gets: as `foldersFor`, or, filed under a project that's the
 * same place by another name (`kuvo.filed`: a link, as its start found it), that project's. Null
 * where the box doesn't list its project: nothing it has is taken away. */
function foldersOf(session: EngineSession, at: string, added = false): readonly string[] | null {
  const filed = session.metadata?.kuvo?.filed;
  const project = isObject(filed) && filed.folder === at && typeof filed.project === "string" ? filed.project : null;
  if (!project || project === at || realish(project) !== realish(at)) return listedFolders(at, readProjects(), added);
  const folders = setFolders(readProjects().find(each => each.directory === project), added);
  if (!folders) return null;
  return folders.includes(at) ? [] : folders;
}

/** What a session on `target` is told of its project's folders (`PROJECT_FOLDERS_ENTRY`): null for
 * nothing, undefined where that can't be read. */
async function folderNoteOf(target: Target, session: string, signal?: AbortSignal): Promise<string | null | undefined> {
  try {
    const entries: unknown = await call(target, "GET", `/api/experimental/session/${encodeURIComponent(session)}/instructions/entries`, undefined, signal);
    if (!Array.isArray(entries)) return undefined;
    const entry = entries.find((each: { key?: unknown } | null) => each?.key === PROJECT_FOLDERS_ENTRY);
    return typeof entry?.value === "string" ? entry.value : null;
  } catch {
    return undefined;
  }
}

/** A session on `target` given its project's other folders as they're set where it is now (or in
 * `folder`, where it's moving: the engine moves one at work at its next step), `foldersFor`: its
 * rules allowing them, in its turn, and its instructions naming them (or neither, for none), each
 * written only where it isn't as it should be (a write makes it the newest). With `whenChanged`,
 * where its instructions can't be read, they're written only where its rules changed. A project
 * the box doesn't list: nothing (its folders are its Mac's to give). A subagent's and a hidden
 * run's (a group chat's seat, an engine run, a review's part) are never given any. False where the
 * engine didn't answer or take it, or it's gone. */
export async function giveFolders(target: Target, session: string, { signal, folder, whenChanged = false }: { signal?: AbortSignal; folder?: string; whenChanged?: boolean } = {}): Promise<boolean> {
  const address = encodeURIComponent(session);
  // (Each folder it's given asked about off the box's thread first, as macOS may ask: a project on
  // your Desktop would hold the box until you answer.)
  const before = await call(target, "GET", `/api/session/${address}`, undefined, signal).catch(() => null) as EngineSession | null;
  if (!before?.id) return false;
  if (before.parentID || isHiddenRun(before)) return true;
  const where = (now: EngineSession) => folder ?? now.location?.directory ?? now.directory ?? null;
  const first = where(before);
  // (Moved into one the box added itself: a project of its own from then on.)
  const added = folder !== undefined;
  // (A project the box doesn't list: its folders are its Mac's to give, so what it has stays.)
  const asked = first ? foldersOf(before, first, added) : null;
  if (!asked) return true;
  // (And the folders its rules and Settings name, which are looked at where they really are.)
  await askedAbout([...asked, ...namedFolders((before.permissions ?? []) as KitRule[])]);
  // (Folders changed again while they were given: given again, so its rules and its note agree.)
  for (let tries = 0; tries < 3; tries++) {
    let at: string | null = null;
    let folders: readonly string[] | null = null;
    let changed = false;
    let seen: EngineSession = before;
    try {
      const done = await rewriteOn(target, session, now => {
        seen = now;
        at = where(now);
        folders = at ? foldersOf(now, at, added) : null;
        if (!folders) return null;
        const current = (now.permissions ?? []) as KitRule[];
        const permissions = withFolders(current, folders, heldOf(now));
        changed = JSON.stringify(permissions) !== JSON.stringify(current);
        return changed ? { permissions } as Partial<EngineSession> : null;
      }, signal);
      if (!done || !at) return false;
    } catch {
      return false;
    }
    if (!folders) return true;
    const given: readonly string[] = folders;
    if (JSON.stringify(foldersOf(seen, at, added)) !== JSON.stringify(given)) continue;
    const entry = `/api/experimental/session/${address}/instructions/entries/${PROJECT_FOLDERS_ENTRY}`;
    const note = given.length ? projectFoldersNote(at, given) : null;
    // (Its note as it should be, or one an earlier write lost: only then written, as a write makes
    // it the newest. Where that can't be read, written where its rules changed.)
    const had = await folderNoteOf(target, session, signal);
    if (had === undefined ? whenChanged && !changed : had === note) return true;
    try {
      if (note) await call(target, "PUT", entry, { value: note }, signal);
      // (None to name: one it had goes; most have none to take away.)
      else await call(target, "DELETE", entry, undefined, signal).catch(() => {});
    } catch {
      return false;
    }
    return true;
  }
  return false;
}

/** The projects New Bot offers here, `{directory, name}` each: the box's own, once it keeps them;
 * before, those its Mac named in the kit. */
export function boxProjects(kit: { projects?: OfferedProject[] } | null | undefined, file = PROJECTS_FILE): OfferedProject[] {
  if (!fs.existsSync(file)) return kit?.projects ?? [];
  return readProjects(file).filter(each => !each.removed).map(each => ({ directory: each.directory, name: each.name ?? path.basename(each.directory) }));
}

/** The list as `change` makes it, read again just before, under its lock. */
export function changeProjects(change: (projects: Project[]) => Project[], file = PROJECTS_FILE, lock = PROJECTS_LOCK): Project[] {
  const projects = locked(lock, () => {
    const projects = change(readProjects(file, false));
    writePrivate(file, JSON.stringify({ version: 1, projects }, null, 2));
    return projects;
  });
  for (const tell of projectFollowers) tell();
  return projects;
}

/** The project each folder sessions run in is filed under, as every client files them
 * (`worktrees` in `kuvo/projects`): a worktree's, as `worktreeProjects` has them, and each
 * project's other folders, its own (not one that's a project of its own: its sessions are its). */
export function filedProjects(projects: Project[] = readProjects()): Record<string, string> {
  const own = new Set(projects.filter(each => !each.removed).map(each => each.directory));
  const filed: Record<string, string> = {};
  for (const project of projects) {
    if (project.removed) continue;
    for (const folder of project.folders) if (!own.has(folder) && !(folder in filed)) filed[folder] = project.directory;
  }
  // (A worktree of a project's other folder's repository is that project's too.)
  const trees = Object.entries(worktreeProjects()).map(([folder, project]) => [folder, filed[project] ?? project]);
  return { ...filed, ...Object.fromEntries(trees) };
}

/** The project a folder sessions run in is filed under: a worktree's, another folder's, or its own. */
export const filedUnder = (folder: string): string => filedProjects()[folder] ?? folder;

/** A project as it's kept: its name only when it's not the folder's, a command only when there
 * is one, its other folders without its own. */
function keptProject(directory: string, given: Record<string, unknown>, before: Partial<Project> = {}): Project {
  const project = { ...before, directory, folders: before.folders ?? [] };
  // Brought back, unless it's sent as removed (a client's copy of one, with its settings).
  if (given.removed === true) project.removed = true;
  else delete project.removed;
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  if ("name" in given) project.name = text(given.name) === path.basename(directory) ? undefined : text(given.name);
  // (Its folders set by a client: from now on the box's to give.)
  if ("folders" in given) delete project.addedByBox;
  if ("folders" in given) project.folders = [...new Set((Array.isArray(given.folders) ? given.folders : []).filter(folder => typeof folder === "string" && path.isAbsolute(folder) && folder !== directory))];
  if ("run" in given) project.run = text(given.run);
  for (const key of ["name", "run"] as const) if (project[key] === undefined) delete project[key];
  return project;
}

/** How many of a project's sessions Remove Project archives at once. */
const ARCHIVING_AT_ONCE = 8;

/** The sessions at work on `target` (the engine's or the bridge's `api/session/active`); null when
 * that can't be read. */
async function atWork(target: Target, signal: AbortSignal | undefined): Promise<Set<string> | null> {
  try {
    const active: unknown = await call(target, "GET", "/api/session/active", undefined, signal);
    if (Array.isArray(active)) return new Set(active.filter((id): id is string => typeof id === "string"));
    return isObject(active) ? new Set(Object.keys(active)) : null;
  } catch {
    return null;
  }
}

/** Every session of the project, its worktrees' and other folders' too (worktrees removed since
 * included, whose sessions clients still show under it, and `also`, folders a client shows under
 * it that this box doesn't know: worktrees removed before it kept them), and those filed under it
 * from another folder (`kuvo.filed`, a subfolder's say), archived, on the engine and the coding
 * agents' bridge, page after page; how many weren't. None while the engine doesn't answer (`kept` null):
 * its sessions are most of them, and the project would come back with them. */
async function archiveProject(directory: string, also: string[], readEngine: () => EngineRecord, readBridge: () => BridgeRecord, signal: AbortSignal | undefined, file = PROJECTS_FILE): Promise<{ archived: number; kept: number | null }> {
  const filed = filedProjects(readProjects(file));
  const trees = Object.entries(filed).filter(([, project]) => project === directory).map(([folder]) => folder);
  const folders = [...new Set([directory, ...trees, ...also])];
  const targets: Target[] = [];
  try { targets.push(readEngine()); } catch { return { archived: 0, kept: null }; }
  // Its record left by one that ended without a word: nothing archived, the bridge's neither.
  try { await call(targets[0], "GET", "/api/session?limit=1", undefined, signal); } catch { return { archived: 0, kept: null }; }
  try {
    const bridge = readBridge();
    if (bridge?.port && bridge?.password && runs(bridge.pid, "kuvo-agents")) targets.push(bridge);
  } catch {}
  let archived = 0, kept = 0;
  for (const target of targets) {
    // Each folder's, then those filed under it from elsewhere, found among all of them.
    for (const folder of [...folders, null]) {
      let query: string | null = `limit=100&order=desc&parentID=null${folder === null ? "" : `&directory=${encodeURIComponent(folder)}`}`;
      for (let page = 0; page < 1000 && query; page++) {
        // The page whole (`call` keeps only its data), for its cursor.
        let listed: SessionPage | undefined;
        try {
          const response = await fetch(`http://127.0.0.1:${target.port}/api/session?${query}`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${target.password}`).toString("base64")}` }, signal });
          if (!response.ok) throw new Error();
          listed = await response.json() as SessionPage;
        } catch {
          kept += 1;
          break;
        }
        const sessions = Array.isArray(listed?.data) ? listed.data : [];
        const archiving = sessions.filter(session => (folder === null ? filedElsewhere(session, directory, filed) : session?.location?.directory === folder) && !session.time?.archived && session.metadata?.["kuvo.archived"] !== true);
        // Only one at work can wait on you (what it asks holds its turn, its subagents' too), so
        // only those are looked at; every one when that can't be read.
        const working = await atWork(target, signal);
        // A few at a time: each is a call to the engine, and a few more for one at work (whether it
        // waits on you, with its subagents), and a big project has hundreds.
        let taken = 0;
        await Promise.all(Array.from({ length: Math.min(ARCHIVING_AT_ONCE, archiving.length) }, async () => {
          while (taken < archiving.length) {
            const session = archiving[taken++]!;
            try {
              // (In its turn, onto its notes as they are then: `../engine/notes.ts`.)
              const done = await rewriteOn(target, session.id, now => (now.metadata?.["kuvo.archived"] === true ? null : { metadata: withNotes(now.metadata, null, { "kuvo.archived": true }) }), signal);
              if (!done) throw new Error("It went.");
              holdArchived(session.id, true);
              // One that waits on you stops, as any archived one does.
              if (!working || working.has(session.id)) await stopIfWaiting(target, session.id);
              archived += 1;
            } catch {
              kept += 1;
            }
          }
        }));
        const next = listed?.cursor?.next;
        query = sessions.length === 100 && next ? `limit=100&cursor=${encodeURIComponent(next)}` : null;
      }
    }
  }
  return { archived, kept };
}

/** Whether `session` is filed under the project at `directory` by its own mark (`kuvo.filed`,
 * while it's still in the folder that names), as every client files one whose folder isn't the
 * project's own nor in `filed`. */
function filedElsewhere(session: EngineSession | undefined, directory: string, filed: Record<string, string>): boolean {
  const mark = session?.metadata?.kuvo?.filed;
  const at = session?.location?.directory;
  return isObject(mark) && mark.project === directory && typeof at === "string" && mark.folder === at && at !== directory && !(at in filed);
}

/** `kuvo/projects`: the box's projects, read and changed by any client, as Settings and the
 * sidebar change them on a Mac. A folder is kept as the client names it. */
export async function* answerProjects(request: LinkRequest, readEngine: () => EngineRecord = readEngineFile, readBridge: () => BridgeRecord = readBridgeFile, signal?: AbortSignal, file = PROJECTS_FILE, lock = PROJECTS_LOCK): AsyncGenerator<AnswerPiece> {
  const json = (status: number, value: unknown): AnswerPiece[] => [{ head: { status, headers: { "content-type": "application/json" } } }, { body: Buffer.from(JSON.stringify(value)) }];
  const [route, query = ""] = request.path.split("?");
  const method = request.method.toUpperCase();
  const listed = (): Projects => {
    const projects = readProjects(file);
    return { projects, worktrees: filedProjects(projects) };
  };
  if (route === "kuvo/projects/events") {
    if (method !== "GET") return yield* json(405, {});
    yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
    return yield* followed(listed, projectFollowers, signal);
  }
  if (route !== "kuvo/projects") return yield* json(404, {});
  if (method === "GET") return yield* json(200, listed());
  const given = new URLSearchParams(query).get("directory");
  if (!given || !path.isAbsolute(given)) return yield* json(400, { message: "Say which folder (directory)." });
  if (method === "PUT") {
    const body = parsed(request.body) ?? {};
    if (!isObject(body)) return yield* json(400, { message: "That isn’t a project." });
    // Kept as it's named: its sessions run there, by that name (a link followed would be another
    // project), and one whose drive isn't there now stays.
    // (Its sessions get its folders as each next runs: `giveFolders`.)
    let project!: Project;
    changeProjects(projects => {
      const before = projects.find(each => each.directory === given);
      project = keptProject(given, body, before);
      return before ? projects.map(each => (each === before ? project : each)) : [project, ...projects];
    }, file, lock);
    return yield* json(200, { project } satisfies { project: Project });
  }
  if (method === "DELETE") {
    const body = parsed(request.body);
    const also = isObject(body) && Array.isArray(body.folders) ? body.folders.filter((folder): folder is string => typeof folder === "string" && path.isAbsolute(folder)) : [];
    const { archived, kept } = await archiveProject(given, also, readEngine, readBridge, signal, file);
    if (kept === null) return yield* json(503, { message: "Its sessions can’t be archived now: the engine isn’t running. Try again in a moment." });
    if (kept > 0) return yield* json(409, { message: `${kept === 1 ? "One of its sessions" : `${kept} of its sessions`} couldn’t be archived, so it stays with them. Try again in a moment.`, archived, kept } satisfies { message: string; archived: number; kept: number });
    changeProjects(projects => {
      const before = projects.find(each => each.directory === given);
      return before ? projects.map(each => (each === before ? { ...each, removed: true } : each)) : projects;
    }, file, lock);
    return yield* json(200, { archived } satisfies { archived: number });
  }
  return yield* json(405, {});
}

// Those following its projects (`kuvo/projects/events`): told of its worktrees' changes too, as the
// list says which project each belongs to.
export const projectFollowers: Set<() => void> = new Set();
worktreeFollowers.add(() => { for (const tell of projectFollowers) tell(); });
// Each project's git worktrees made elsewhere are filed under it too (`worktreeProjects`).
linkedTreesOf(() => readProjects().filter(project => !project.removed).map(project => project.directory));
linkedFollowers.add(() => { for (const tell of projectFollowers) tell(); });

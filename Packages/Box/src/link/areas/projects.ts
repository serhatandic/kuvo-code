// Projects: the box's own list (PROTOCOL.md, "Projects"), which every client reads and changes here.

import fs from "node:fs";
import path from "node:path";
import { isObject, parsed } from "../../shared/json";
import { processRuns as runs } from "../../shared/platform";
import type { BridgeRecord, EngineRecord, Target } from "../../shared/records";
import type { Project, Projects } from "../../shared/routes/projects";
import { call, readBridgeFile, readEngineFile } from "../engine/client";
import type { EngineSession } from "../engine/sessions";
import { locked, writePrivate } from "../files";
import { followed } from "../follow";
import { K } from "../home";
import type { AnswerPiece, LinkRequest } from "../server/context";
import { holdArchived } from "./wakes";
import { readWorktrees } from "./worktree-records";

const PROJECTS_FILE = path.join(K, "box", "projects.json");
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

/** The box's projects: `{directory, name?, folders, run?, terminal?, removed?}` each. One removed
 * (Remove Project) keeps its settings, for when one of its sessions is brought back. */
export function readProjects(file = PROJECTS_FILE): Project[] {
  try {
    const list = JSON.parse(fs.readFileSync(file, "utf8")).projects;
    return Array.isArray(list) ? list.filter(each => typeof each?.directory === "string" && path.isAbsolute(each.directory)).map(each => ({ ...each, folders: Array.isArray(each.folders) ? each.folders.filter((folder: unknown) => typeof folder === "string") : [] })) : [];
  } catch {
    return [];
  }
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
    const projects = change(readProjects(file));
    writePrivate(file, JSON.stringify({ version: 1, projects }, null, 2));
    return projects;
  });
  for (const tell of projectFollowers) tell();
  return projects;
}

/** A project as it's kept: its name only when it's not the folder's, a command only when there
 * is one, its other folders without its own. */
function keptProject(directory: string, given: Record<string, unknown>, before: Partial<Project> = {}): Project {
  const project = { ...before, directory, folders: before.folders ?? [] };
  // Brought back, unless it's sent as removed (a client's copy of one, with its settings).
  if (given.removed === true) project.removed = true;
  else delete project.removed;
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  if ("name" in given) project.name = text(given.name) === path.basename(directory) ? undefined : text(given.name);
  if ("folders" in given) project.folders = [...new Set((Array.isArray(given.folders) ? given.folders : []).filter(folder => typeof folder === "string" && path.isAbsolute(folder) && folder !== directory))];
  if ("run" in given) project.run = text(given.run);
  if ("terminal" in given) project.terminal = text(given.terminal);
  for (const key of ["name", "run", "terminal"] as const) if (project[key] === undefined) delete project[key];
  return project;
}

/** Every session of the project, its worktrees' too, archived, on the engine and the coding
 * agents' bridge, page after page; how many weren't. */
async function archiveProject(directory: string, readEngine: () => EngineRecord, readBridge: () => BridgeRecord, signal: AbortSignal | undefined): Promise<{ archived: number; kept: number | null }> {
  const folders = [directory, ...readWorktrees().filter(tree => tree.project === directory && typeof tree.folder === "string").map(tree => tree.folder!)];
  const targets: Target[] = [];
  try { targets.push(readEngine()); } catch {}
  try {
    const bridge = readBridge();
    if (bridge?.port && bridge?.password && runs(bridge.pid, "kuvo-agents")) targets.push(bridge);
  } catch {}
  if (!targets.length) return { archived: 0, kept: null };
  let archived = 0, kept = 0;
  for (const target of targets) {
    for (const folder of folders) {
      let query: string | null = `limit=100&order=desc&parentID=null&directory=${encodeURIComponent(folder)}`;
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
        for (const session of sessions) {
          if (session?.location?.directory !== folder || session.time?.archived || session.metadata?.["kuvo.archived"] === true) continue;
          try {
            await call(target, "PATCH", `/api/session/${encodeURIComponent(session.id)}`, { metadata: { ...(session.metadata ?? {}), "kuvo.archived": true } }, signal);
            holdArchived(session.id, true);
            archived += 1;
          } catch {
            kept += 1;
          }
        }
        const next = listed?.cursor?.next;
        query = sessions.length === 100 && next ? `limit=100&cursor=${encodeURIComponent(next)}` : null;
      }
    }
  }
  return { archived, kept };
}

/** `kuvo/projects`: the box's projects, read and changed by any client, as Settings and the
 * sidebar change them on a Mac. A folder is kept as the client names it. */
export async function* answerProjects(request: LinkRequest, readEngine: () => EngineRecord = readEngineFile, readBridge: () => BridgeRecord = readBridgeFile, signal?: AbortSignal, file = PROJECTS_FILE, lock = PROJECTS_LOCK): AsyncGenerator<AnswerPiece> {
  const json = (status: number, value: unknown): AnswerPiece[] => [{ head: { status, headers: { "content-type": "application/json" } } }, { body: Buffer.from(JSON.stringify(value)) }];
  const [route, query = ""] = request.path.split("?");
  const method = request.method.toUpperCase();
  const listed = (): Projects => ({ projects: readProjects(file) });
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
    let project!: Project;
    changeProjects(projects => {
      const before = projects.find(each => each.directory === given);
      project = keptProject(given, body, before);
      return before ? projects.map(each => (each === before ? project : each)) : [project, ...projects];
    }, file, lock);
    return yield* json(200, { project } satisfies { project: Project });
  }
  if (method === "DELETE") {
    const { archived, kept } = await archiveProject(given, readEngine, readBridge, signal);
    if (kept === null) return yield* json(503, { message: "Its sessions can’t be reached: the engine isn’t running." });
    if (kept > 0) return yield* json(409, { message: `${kept === 1 ? "One of its sessions" : `${kept} of its sessions`} couldn’t be archived, so it stays with them. Try again in a moment.`, archived, kept } satisfies { message: string; archived: number; kept: number });
    changeProjects(projects => {
      const before = projects.find(each => each.directory === given);
      return before ? projects.map(each => (each === before ? { ...each, removed: true } : each)) : projects;
    }, file, lock);
    return yield* json(200, { archived } satisfies { archived: number });
  }
  return yield* json(405, {});
}

// Those following its projects (`kuvo/projects/events`).
const projectFollowers: Set<() => void> = new Set();

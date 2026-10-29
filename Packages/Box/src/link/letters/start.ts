// A new session started with a task (PROTOCOL.md, "Agents' tools": `POST kuvo/sessions`, and the
// start_session tool on every box)
// From a conversation: an agent of its own, in that one's folder (or the one given), on its model,
// in its mode (Plan stays Plan), with its approval, so Ask First isn't got around; it gets the task as a message from the
// conversation, so it knows who to report to, and its metadata says who started it, for every client
// to show it beside them. From a client (no `startedBy`): the task as the user's own first message.

import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { asked, call } from "../engine/client";
import { messageID } from "../engine/sessions";
import { BOTS, CHATS, HERE, homeFolder } from "../home";
import { changeProjects, PROJECTS_FILE, readProjects } from "../areas/projects";
import { readWorktrees } from "../areas/worktree-records";
import { tellWorktree } from "../areas/worktrees";
import { permissionsHere, refreshedRules } from "../bots/tell";
import { composeLetter } from "./letter";
import { allowed, takeBack } from "./limits";
import { answerTo } from "./take";
import type { Target } from "../../shared/records";
import type { KitRule } from "../bots/kit";
import type { EngineSession } from "../engine/sessions";
import type { SessionPlace } from "./letter";

/** What a session's start is given: its task, and what's optional. (Room for more, later: unknown
 * fields are ignored, so a newer client can ask an older box.) */
export interface StartGiven {
  task?: unknown;
  title?: unknown;
  folder?: unknown;
  wait?: unknown;
}

/** The conversation starting it: its root (a subagent's, an engine run's), where it runs, and its
 * name as the other agents know it; or an agent outside any conversation this box has
 * (`OUTSIDE`). */
export interface Starter {
  session: string;
  place: SessionPlace | null;
  name: string;
}

/** An agent's call from no conversation this box has: counted together, its task from "another
 * agent" that can't be answered, and asking first, as nothing says it may do more. */
export const OUTSIDE: Starter = { session: "unknown", place: null, name: "another agent" };
const ASKS_FIRST: NonNullable<EngineSession["permissions"]> = [{ action: "shell", resource: "*", effect: "ask" }];

/** A session started: its address, title, folder and project (null for a chat), and with `wait`,
 * its first answer (null for none yet). */
export interface Started {
  session: string;
  title: string | null;
  folder: string;
  project: string | null;
  answer?: string | null;
}

/** Why one wasn't started (a 502 was, but its task didn't reach it: `session`). */
export interface StartRefusal {
  status: 400 | 403 | 429 | 502 | 503;
  message: string;
  session?: string;
}

/** Where it's started, and how it's waited for: the engine here, between looks for its answer (ms),
 * until its asker goes. */
export interface StartPlace {
  readEngine: () => Target;
  step?: number;
  signal?: AbortSignal;
}

const SEAT = "Not from a group chat: talk it through here; the work is handed out after the wrap-up.";
export const seatRefusal = (): StartRefusal => ({ status: 403, message: SEAT });

// A bot's own folder, whose sessions would be listed nowhere: one it starts there is a chat.
const isBotFolder = (folder: string) => folder.startsWith(path.resolve(BOTS) + "/");

// Its project's other folders, allowed to it as the Mac allows them (ProjectFolders): symlinks
// resolved too, after its approval's rules (the last that matches wins).
function folderRules(folders: readonly string[]): KitRule[] {
  const paths: string[] = [];
  for (const folder of folders) {
    let real = folder;
    try { real = fs.realpathSync(folder); } catch {}
    for (const each of [folder, real]) if (!paths.includes(each)) paths.push(each);
  }
  return paths.map(each => ({ action: "external_directory", resource: path.join(each, "*"), effect: "allow" }));
}
const isFolderRule = (rule: KitRule) => rule.action === "external_directory" && rule.effect === "allow" && rule.resource.endsWith("/*");

// Its rules: the starting conversation's approval (Approve All from a client), made again with
// Settings › Permissions as they are now where they're this box's own, else as they are; its own
// folders' rules for its project's (a bot's own folder stays allowed). None from a client on a box
// whose settings aren't its own: the engine's own then.
function rulesFor(parent: Partial<EngineSession> | null, folders: readonly string[]): KitRule[] | undefined {
  const own = Array.isArray(parent?.permissions) ? parent.permissions.filter(rule => !isFolderRule(rule) || rule.resource.includes("/bots/bot_")) : null;
  const settings = permissionsHere();
  const made = settings ? refreshedRules(own ?? [], settings) : own;
  if (!made && !folders.length) return undefined;
  return [...(made ?? []), ...folderRules(folders)];
}

const projectsNote = (primary: string, folders: readonly string[]) =>
  `This project spans several folders. You work in its primary folder, ${path.basename(primary)} (${primary}). These folders belong to the project too, and you can read, search and change files in them the same way:\n${folders.map(folder => `- ${path.basename(folder)}: ${folder}`).join("\n")}\nWhen the user mentions one of these folders by name, they mean that folder.`;

// The project a folder is (one of its worktrees is its project's), its name and other folders; a
// folder that's none yet becomes one, as a Mac adds it when a session starts there. Null for chats.
function projectOf(folder: string): { name: string; folders: readonly string[] } | null {
  if (folder === CHATS) return null;
  const tree = readWorktrees().find(each => (each.folder ?? each.root) === folder);
  const directory = tree?.project ?? folder;
  const known = readProjects().find(each => each.directory === directory);
  // (Only once the box keeps its projects: before, they're its Mac's.)
  if (!known && !tree && fs.existsSync(PROJECTS_FILE)) {
    try { changeProjects(projects => (projects.some(each => each.directory === directory) ? projects : [{ directory, folders: [] }, ...projects])); } catch {}
  }
  return { name: known?.name ?? path.basename(directory), folders: tree ? [] : (known?.folders ?? []) };
}

/** A new session with `given`'s task, from the conversation `by` (null: from a client). It's counted
 * against the conversation's sessions, a few in a while (`limits.ts`). */
export async function startSession(given: StartGiven, by: Starter | null, place: StartPlace): Promise<{ started: Started } | { refused: StartRefusal }> {
  const no = (status: StartRefusal["status"], message: string, session?: string) => ({ refused: { status, message, ...(session ? { session } : {}) } });
  const task = typeof given.task === "string" ? given.task.trim() : "";
  if (!task) return no(400, "Say what it's to do (task).");
  if (by?.place?.data.metadata?.kuvo?.seat) return { refused: seatRefusal() };
  const parent = by ? by.place?.data ?? { permissions: ASKS_FIRST } : null;
  const parentFolder = parent?.location?.directory ?? parent?.directory;
  let folder = parentFolder ? (isBotFolder(parentFolder) ? CHATS : parentFolder) : null;
  if (typeof given.folder === "string" && given.folder.trim()) {
    const written = given.folder.trim();
    const full = written.replace(/^~(?=$|\/)/, homeFolder());
    let isFolder = false;
    try { isFolder = fs.statSync(full).isDirectory(); } catch {}
    if (!path.isAbsolute(full) || !isFolder) return no(400, `${written} isn't a folder on ${HERE}. Give a full path to one.`);
    folder = isBotFolder(full) ? CHATS : full;
  }
  if (!folder) return no(400, "Give the folder it works in (folder), as a full path.");
  // A few at a time: an agent shouldn't fill the window with sessions unattended.
  const key = by ? (by.place ? by.session : "outside") : null;
  const counted = key ? allowed("sessions", key) : null;
  if (key && counted === null) return no(429, "You've started several sessions in the last few minutes. Write to those (send_message), or ask the user before starting more.");
  const giveBack = () => { if (key && counted !== null) takeBack("sessions", key, counted); };
  // Where the conversation that starts it runs (the engine, or the coding agents' bridge).
  let target: Target;
  try {
    target = by?.place?.target ?? place.readEngine();
  } catch {
    giveBack();
    return no(503, `The engine on ${HERE} isn't running.`);
  }
  const project = projectOf(folder);
  const title = typeof given.title === "string" && given.title.trim() ? given.title.trim() : null;
  const rules = rulesFor(parent, project?.folders ?? []);
  let session: string;
  try {
    const made = await call(target, "POST", "/api/session", { location: { directory: folder }, ...(title ? { title } : {}), ...(parent?.model ? { model: parent.model } : {}), ...(parent?.agent ? { agent: parent.agent } : {}), ...(rules ? { permissions: rules } : {}) }, place.signal);
    if (!isObject(made) || typeof made.id !== "string" || !made.id) throw new Error("No session was made.");
    session = made.id;
  } catch (error) {
    giveBack();
    return no(502, `Couldn't start a session in ${folder}: ${String((error as Error | null)?.message ?? error)}`);
  }
  const address = encodeURIComponent(session);
  if (project?.folders.length) {
    await call(target, "PUT", `/api/experimental/session/${address}/instructions/entries/kuvo.project-folders`, { value: projectsNote(folder, project.folders) }).catch(() => {});
  }
  await tellWorktree(target, session).catch(() => {});
  if (by?.place) await call(target, "PATCH", `/api/session/${address}`, { metadata: { kuvo: { startedBy: by.session } } }).catch(() => {});
  const waits = given.wait === true;
  const id = messageID();
  try {
    await asked(target, "POST", `api/session/${address}/prompt`, { id, text: by ? composeLetter(by.name, by.session, task, waits) : task, delivery: "steer" });
  } catch (error) {
    return no(502, `Started a session (${session}), but the task didn't reach it: ${String((error as Error | null)?.message ?? error)}`, session);
  }
  const started: Started = { session, title, folder, project: project?.name ?? null };
  if (!waits) return { started };
  // A new session: anything it says is its answer.
  return { started: { ...started, answer: await answerTo(target, session, id, { wait: place.step, signal: place.signal }) } };
}

/** How a start went, in the words the tool gives its agent. */
export function startedWords(outcome: { started: Started } | { refused: StartRefusal }, waits: boolean): { text: string; isError: boolean } {
  if ("refused" in outcome) return { text: outcome.refused.message, isError: true };
  const { session, title, project, answer } = outcome.started;
  const name = title ? `"${title}"` : "a new session";
  const where = project ? ` in ${project}` : "";
  if (!waits) return { text: `Started ${name}${where} (address ${session}). It's on it now. Write to it with send_message; it can write back to you the same way.`, isError: false };
  return { text: `Started ${name}${where} (address ${session}). ` + (answer ? `It answered:\n\n${answer}` : "It hasn't answered yet; it may still write back with send_message."), isError: false };
}

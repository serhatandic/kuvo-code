// What each session is, as every client's lists go by it (PROTOCOL.md, "Session lists"): a
// project's session filed under its project, a chat, a bot's conversation, a seat in a group chat, a
// run kept out of sight, or a subagent's; and the projects the lists show. The rule the Mac's sidebar
// went by (`Workspace.makeProjects`, `chats`), here so no client works it out. Pure: what the box
// knows comes in `ListPlace`, so the vectors (`Packages/KuvoLink/Vectors/session-lists.json`) check it.

import path from "node:path";
import { isObject } from "../../shared/json";
import type { EngineSession } from "../engine/sessions";
import type { ListedProject, SessionFacts, SessionKind } from "../../shared/routes/sessions";

/** What the rule reads of the box beside a session. */
export interface ListPlace {
  /** Whether a folder is the box's chats folder. */
  isChatsFolder: (directory: string) => boolean;
  /** The box's bots folder: a session in a bot's folder there is the bot's. */
  botsFolder: string;
  /** Its bots' conversations. */
  botSessions: ReadonlySet<string>;
  /** The project each folder sessions run in is filed under, where it isn't its own
   * (`filedProjects`: a worktree's, a project's other folder's). */
  filed: Readonly<Record<string, string>>;
  /** Its projects, as `kuvo/projects` keeps them. */
  projects: readonly { directory: string; name?: string; removed?: boolean }[];
  /** Those at work now. */
  running: ReadonlySet<string>;
  /** Since when each waits on you (ms), its subagents' asks counting as its own. */
  asked: ReadonlyMap<string, number>;
  /** Copies that aren't this box's own (moved away, or on their way here). */
  away: ReadonlySet<string>;
}

/** A session's folder, as the engine names it. */
export const folderOf = (session: Partial<EngineSession>): string => session.location?.directory ?? session.directory ?? "";

const kuvoOf = (session: Partial<EngineSession>): Record<string, unknown> => (isObject(session.metadata?.kuvo) ? session.metadata.kuvo : {});

/** Archived (here, by a client's note, or by an older opencode). */
export const isArchived = (session: Partial<EngineSession>): boolean =>
  Boolean(session.time?.archived) || session.metadata?.["kuvo.archived"] === true || kuvoOf(session).archived === true;

/** Kept at the top of the lists. */
export const isPinned = (session: Partial<EngineSession>): boolean => session.metadata?.["kuvo.pinned"] === true;

/** Whether `folder` is in the bots folder (a bot's own, even before the bot's listed). */
const inBotsFolder = (folder: string, botsFolder: string): boolean => Boolean(botsFolder) && folder.startsWith(botsFolder.endsWith(path.sep) ? botsFolder : botsFolder + path.sep);

/** What `session` is. */
export function kindOf(session: EngineSession, place: ListPlace): SessionKind {
  if (typeof session.parentID === "string" && session.parentID) return "subagent";
  const kuvo = kuvoOf(session);
  if (kuvo.seat !== undefined && kuvo.seat !== null) return "seat";
  if ((kuvo.engineFor !== undefined && kuvo.engineFor !== null) || (kuvo.reviewPart !== undefined && kuvo.reviewPart !== null)) return "hidden";
  const folder = folderOf(session);
  // (Its bots' as its bots list them: a `kuvo.bot` note alone doesn't make one a bot's.)
  if (place.botSessions.has(session.id) || inBotsFolder(folder, place.botsFolder)) return "bot";
  // A chat as its box marks it (the mark naming the folder it's in), else by its folder: a chat from
  // before the mark, or not marked yet.
  if ((typeof kuvo.chat === "string" && kuvo.chat === folder) || place.isChatsFolder(folder)) return "chat";
  return "project";
}

/** The project a project's session is filed under: as the box files its folder, else as it was
 * filed as it was made (`kuvo.filed`, while it still runs in that folder: a worktree not listed yet,
 * a subfolder), that project as the box files it, else its own folder. */
export function projectOf(session: EngineSession, filed: Readonly<Record<string, string>>): string {
  const folder = folderOf(session);
  const said = filed[folder];
  if (said !== undefined) return said;
  const mark = kuvoOf(session).filed;
  if (isObject(mark) && mark.folder === folder && typeof mark.project === "string" && mark.project && mark.project !== folder) return filed[mark.project] ?? mark.project;
  return folder;
}

/** The facts of one session. */
export function factsOf(session: EngineSession, place: ListPlace): SessionFacts {
  const kind = kindOf(session, place);
  const facts: { -readonly [K in keyof SessionFacts]: SessionFacts[K] } = {
    kind,
    directory: folderOf(session),
    created: Number(session.time?.created) || 0,
    updated: Number(session.time?.updated) || 0,
  };
  if (kind === "project") facts.project = projectOf(session, place.filed);
  if (typeof session.title === "string" && session.title) facts.title = session.title;
  if (kind === "subagent") facts.parent = session.parentID;
  if (isPinned(session)) facts.pinned = true;
  if (isArchived(session)) facts.archived = true;
  if (place.running.has(session.id)) facts.running = true;
  const asked = place.asked.get(session.id);
  if (asked !== undefined) facts.asked = asked;
  if (place.away.has(session.id)) facts.away = true;
  return facts;
}

/** The projects the lists show: its list's (not removed), and each one a session listed in a project
 * (not archived) is filed under. Each with its name, where its list gives one, and when its newest
 * such session changed. */
export function listedProjects(sessions: Readonly<Record<string, SessionFacts>>, place: Pick<ListPlace, "projects">): Record<string, ListedProject> {
  const names = new Map<string, string | undefined>();
  for (const project of place.projects) if (!project.removed) names.set(project.directory, project.name);
  const newest = new Map<string, number>();
  for (const facts of Object.values(sessions)) {
    if (facts.kind !== "project" || facts.archived || facts.project === undefined) continue;
    newest.set(facts.project, Math.max(newest.get(facts.project) ?? 0, facts.updated));
  }
  const projects: Record<string, ListedProject> = {};
  for (const directory of [...new Set([...names.keys(), ...newest.keys()])].sort()) {
    // (Named as its list names it, a removed one's too, which a session brings back.)
    const name = names.get(directory) ?? place.projects.find(each => each.directory === directory)?.name;
    const updated = newest.get(directory);
    projects[directory] = { ...(name ? { name } : {}), ...(updated !== undefined ? { updated } : {}) };
  }
  return projects;
}

// Projects (PROTOCOL.md, "Projects"): the box's own list, which every client reads and changes.

import { bool, type Infer, list, map, number, object, type RouteShape, string } from "../shape";

/** A project: its folder, its name (only when it isn't the folder's own), its other folders, the
 * command Run starts (left out for none), and `removed`, for one Remove
 * Project took off the list, kept with its settings for when one of its sessions comes back; and
 * the bot that made it, for one a bot made (`make_project`); `addedByBox`, for one the box added
 * itself as a session started in a folder it didn't list, whose folders no client has set yet. */
export const PROJECT = object({
  directory: string,
  "name?": string,
  folders: list(string),
  "run?": string,
  "removed?": bool,
  "madeBy?": object({ bot: string, name: string, at: number }),
  "addedByBox?": bool,
});
/** The box's projects, newest first, and `worktrees`: the project each of its worktrees' folders
 * belongs to, by the folder sessions run in (those it keeps, those it removed that can come back,
 * and those removed before), so every client files a session in one under its project. */
export const PROJECTS = object({ projects: list(PROJECT), worktrees: map(string) });

export type Project = Infer<typeof PROJECT>;
export type Projects = Infer<typeof PROJECTS>;

export const PROJECT_ROUTES: RouteShape[] = [
  { route: "GET kuvo/projects", answers: { 200: PROJECTS } },
  { route: "PUT kuvo/projects", answers: { 200: object({ project: PROJECT }) } },
  // Removed: how many of its sessions were archived.
  // (A project with sessions that couldn't be archived stays, and says how many were and weren't.)
  { route: "DELETE kuvo/projects", answers: { 200: object({ archived: number }), 409: object({ message: string, archived: number, kept: number }) } },
];
